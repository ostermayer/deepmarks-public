// Build a NIP-98 auth header + POST a signed Nostr event to
// api.deepmarks.org/publish from native code. Used by the
// DeepmarksShare extension to publish kind:39701 public bookmarks and
// encrypted kind:30003 private-item bookmarks
// without waiting for the main app to foreground.
//
// The POST uses a regular URLSession data task — extensions are
// allowed to run network requests during their UI session. We do
// NOT switch to a background URLSession config because:
//   - The total request is small (<1 KB) and finishes well within
//     the share-sheet's UI lifetime
//   - Background URLSession requires a delegate + completion handler
//     in the host app, which adds plumbing for negligible benefit
//   - On failure the share is still appended to the AppGroup
//     pending-shares queue so the main app's share-drain retries

import Foundation
import CryptoKit

public struct PublishApiResponse {
    public let queued: Int
    public let acceptedIds: [String]
}

public enum NostrPublishError: Error {
    case noNsecInKeychain
    case pubkeyMismatch(expected: String, actual: String)
    case signingFailed(Error)
    case nip98Failed(Error)
    case requestFailed(Error)
    case serverRejected(status: Int, body: String)
    case malformedResponse
}

public enum NostrPublish {
    /// API base for our publish endpoint. Could be made configurable
    /// later, but matches the JS frontend's `config.apiBase`.
    public static let apiBase = "https://api.deepmarks.org"
    private static let clientHandler = "31990:2944e915ba71cf0fc19f5dda048ce053a87c01fd7478b179330a17edca4ce2f4:deepmarks"

    /// Build, sign, and POST a kind:39701 public bookmark event to
    /// /publish. Returns the server's response or throws a typed
    /// error so callers can fall back to AppGroup queueing on
    /// transient failures.
    public static func publicBookmark(
        url: String,
        title: String?,
        description: String?,
        tags: [String],
        publishedAt: Int = Int(Date().timeIntervalSince1970),
        publishedAtMs: Int64? = nil,
        expectedPubkey: String? = nil
    ) async throws -> PublishApiResponse {
        guard let nsecHex = KeychainSharedStore.loadNsecHex() else {
            throw NostrPublishError.noNsecInKeychain
        }

        let eventTags = bookmarkTags(
            url: url,
            title: title,
            description: description,
            tags: tags,
            publishedAt: publishedAt,
            publishedAtMs: publishedAtMs
        )

        let signed: NostrEvent
        do {
            signed = try NostrSigner.sign(
                nsecHex: nsecHex,
                kind: 39701,
                tags: eventTags,
                content: "",
                createdAt: publishedAt
            )
        } catch {
            throw NostrPublishError.signingFailed(error)
        }
        if let expected = normalizedPubkey(expectedPubkey), signed.pubkey != expected {
            throw NostrPublishError.pubkeyMismatch(expected: expected, actual: signed.pubkey)
        }

        return try await postSignedEvents([signed], nsecHex: nsecHex)
    }

    /// Build, sign, and POST one encrypted private-item kind:30003. This
    /// avoids rewriting the full chunked private set from an extension process.
    public static func privateBookmark(
        url: String,
        title: String?,
        description: String?,
        tags: [String],
        publishedAt: Int = Int(Date().timeIntervalSince1970),
        publishedAtMs: Int64? = nil,
        expectedPubkey: String? = nil
    ) async throws -> PublishApiResponse {
        guard let nsecHex = KeychainSharedStore.loadNsecHex() else {
            throw NostrPublishError.noNsecInKeychain
        }
        let actualPubkey = try NostrSigner.publicKeyHex(nsecHex: nsecHex)
        if let expected = normalizedPubkey(expectedPubkey), actualPubkey != expected {
            throw NostrPublishError.pubkeyMismatch(expected: expected, actual: actualPubkey)
        }
        let innerTags = bookmarkTags(
            url: url,
            title: title,
            description: description,
            tags: tags,
            publishedAt: publishedAt,
            publishedAtMs: publishedAtMs
        )
        let plaintextData = try JSONSerialization.data(
            withJSONObject: [innerTags],
            options: [.withoutEscapingSlashes]
        )
        guard let plaintext = String(data: plaintextData, encoding: .utf8) else {
            throw NostrPublishError.malformedResponse
        }
        let conversationKey = try NostrNip44.conversationKey(nsecHex: nsecHex, peerPubkeyHex: actualPubkey)
        let ciphertext = try NostrNip44.encrypt(plaintext, conversationKey: conversationKey)
        let signed = try NostrSigner.sign(
            nsecHex: nsecHex,
            kind: 30003,
            tags: [["d", NostrNip44.privateItemName(for: url)]],
            content: ciphertext,
            createdAt: publishedAt
        )
        return try await postSignedEvents([signed], nsecHex: nsecHex)
    }

    private static func bookmarkTags(
        url: String,
        title: String?,
        description: String?,
        tags: [String],
        publishedAt: Int,
        publishedAtMs: Int64?
    ) -> [[String]] {
        // Mirrors the web frontend's buildBookmarkEvent so public events and
        // encrypted private item payloads render identically wherever read.
        var eventTags: [[String]] = [
            ["d", url],
            ["title", title ?? ""],
            ["description", description ?? ""],
        ]
        var seen = Set<String>()
        for tag in tags {
            let trimmed = tag.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if trimmed.isEmpty || seen.contains(trimmed) { continue }
            seen.insert(trimmed)
            eventTags.append(["t", trimmed])
        }
        eventTags.append(["published_at", String(publishedAt)])
        if let ms = publishedAtMs, ms > 0, ms / 1000 == publishedAt {
            eventTags.append(["published_at_ms", String(ms)])
        }
        eventTags.append(["client", "Deepmarks", clientHandler])
        return eventTags
    }

    private static func postSignedEvents(_ events: [NostrEvent], nsecHex: String) async throws -> PublishApiResponse {
        let postUrl = "\(apiBase)/publish"
        struct PublishBody: Encodable { let events: [NostrEvent] }
        let bodyData: Data
        do {
            bodyData = try JSONEncoder().encode(PublishBody(events: events))
        } catch {
            throw NostrPublishError.signingFailed(error)
        }

        let authHeader: String
        do {
            authHeader = try buildNip98AuthHeader(
                url: postUrl,
                method: "POST",
                body: bodyData,
                nsecHex: nsecHex
            )
        } catch {
            throw NostrPublishError.nip98Failed(error)
        }

        var request = URLRequest(url: URL(string: postUrl)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(authHeader, forHTTPHeaderField: "Authorization")
        request.httpBody = bodyData
        request.timeoutInterval = 20

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw NostrPublishError.requestFailed(error)
        }
        guard let http = response as? HTTPURLResponse else {
            throw NostrPublishError.malformedResponse
        }
        if !(200..<300).contains(http.statusCode) {
            let bodyStr = String(data: data, encoding: .utf8) ?? ""
            throw NostrPublishError.serverRejected(status: http.statusCode, body: bodyStr)
        }
        struct PublishResult: Codable { let queued: Int; let acceptedIds: [String]? }
        let decoded = try? JSONDecoder().decode(PublishResult.self, from: data)
        return PublishApiResponse(
            queued: decoded?.queued ?? 0,
            acceptedIds: decoded?.acceptedIds ?? []
        )
    }

    private static func normalizedPubkey(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let pubkey = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard pubkey.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else {
            return nil
        }
        return pubkey
    }

    /// Build a NIP-98 Authorization header value: `Nostr <base64(event)>`
    /// where event is a kind:27235 signed by the user's nsec, bound to
    /// the request URL + method + sha256(body).
    private static func buildNip98AuthHeader(
        url: String,
        method: String,
        body: Data,
        nsecHex: String
    ) throws -> String {
        let payloadHash = SHA256.hash(data: body)
        let payloadHex = Data(payloadHash).hexEncoded()
        let nonce = UUID().uuidString
        let tags: [[String]] = [
            ["u", url],
            ["method", method.uppercased()],
            ["nonce", nonce],
            ["payload", payloadHex],
        ]
        let event = try NostrSigner.sign(
            nsecHex: nsecHex,
            kind: 27235,
            tags: tags,
            content: ""
        )
        let json = try JSONEncoder().encode(event)
        let b64 = json.base64EncodedString()
        return "Nostr \(b64)"
    }
}
