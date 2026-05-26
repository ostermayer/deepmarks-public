import CryptoKit
import Foundation
import Security
import libsecp256k1

public struct NostrEvent: Codable {
    public let id: String
    public let pubkey: String
    public let createdAt: Int
    public let kind: Int
    public let tags: [[String]]
    public let content: String
    public let sig: String

    enum CodingKeys: String, CodingKey {
        case id, pubkey, kind, tags, content, sig
        case createdAt = "created_at"
    }

    public init(id: String, pubkey: String, createdAt: Int, kind: Int, tags: [[String]], content: String, sig: String) {
        self.id = id
        self.pubkey = pubkey
        self.createdAt = createdAt
        self.kind = kind
        self.tags = tags
        self.content = content
        self.sig = sig
    }
}

public enum NostrSigningError: Error {
    case invalidNsec
    case canonicalSerializationFailed
    case randomBytesFailed
    case signingFailed
}

private enum Secp256k1Nostr {
    static let context: OpaquePointer = {
        guard let context = secp256k1_context_create(UInt32(SECP256K1_CONTEXT_NONE)) else {
            preconditionFailure("Failed to create secp256k1 context")
        }

        if var random = try? randomBytes(count: 32) {
            precondition(
                secp256k1_context_randomize(context, &random) == 1,
                "Failed to randomize secp256k1 context"
            )
        }

        return context
    }()

    static func randomBytes(count: Int) throws -> [UInt8] {
        var bytes = [UInt8](repeating: 0, count: count)
        let status = bytes.withUnsafeMutableBytes { buffer in
            SecRandomCopyBytes(kSecRandomDefault, count, buffer.baseAddress!)
        }
        guard status == errSecSuccess else {
            throw NostrSigningError.randomBytesFailed
        }
        return bytes
    }
}

public enum NostrSigner {
    public static func canonicalEventData(
        pubkey: String,
        createdAt: Int,
        kind: Int,
        tags: [[String]],
        content: String
    ) throws -> Data {
        let canonical: [Any] = [0, pubkey, createdAt, kind, tags, content]
        guard JSONSerialization.isValidJSONObject(canonical) else {
            throw NostrSigningError.canonicalSerializationFailed
        }
        return try JSONSerialization.data(
            withJSONObject: canonical,
            options: [.withoutEscapingSlashes]
        )
    }

    public static func eventId(
        pubkey: String,
        createdAt: Int,
        kind: Int,
        tags: [[String]],
        content: String
    ) throws -> (hash: Data, hex: String) {
        let canonical = try canonicalEventData(
            pubkey: pubkey,
            createdAt: createdAt,
            kind: kind,
            tags: tags,
            content: content
        )
        let hash = Data(SHA256.hash(data: canonical))
        return (hash, hash.hexEncoded())
    }

    public static func sign(
        nsecHex: String,
        kind: Int,
        tags: [[String]],
        content: String,
        createdAt: Int = Int(Date().timeIntervalSince1970)
    ) throws -> NostrEvent {
        guard let secretBytes = secretKeyBytes(nsecHex: nsecHex) else {
            throw NostrSigningError.invalidNsec
        }

        let context = Secp256k1Nostr.context
        var keypair = secp256k1_keypair()
        guard secp256k1_keypair_create(context, &keypair, secretBytes) == 1 else {
            throw NostrSigningError.invalidNsec
        }

        var xonlyPubKey = secp256k1_xonly_pubkey()
        var keyParity: Int32 = 0
        var pubkeyBytes = [UInt8](repeating: 0, count: 32)
        guard secp256k1_keypair_xonly_pub(context, &xonlyPubKey, &keyParity, &keypair) == 1,
              secp256k1_xonly_pubkey_serialize(context, &pubkeyBytes, &xonlyPubKey) == 1
        else {
            throw NostrSigningError.signingFailed
        }
        let pubkeyHex = Data(pubkeyBytes).hexEncoded()

        let (hash, idHex) = try eventId(
            pubkey: pubkeyHex,
            createdAt: createdAt,
            kind: kind,
            tags: tags,
            content: content
        )
        let messageBytes = [UInt8](hash)
        var auxRand = try Secp256k1Nostr.randomBytes(count: 32)
        var sigBytes = [UInt8](repeating: 0, count: 64)

        guard secp256k1_schnorrsig_sign32(context, &sigBytes, messageBytes, &keypair, &auxRand) == 1,
              secp256k1_schnorrsig_verify(context, sigBytes, messageBytes, messageBytes.count, &xonlyPubKey) == 1
        else {
            throw NostrSigningError.signingFailed
        }

        return NostrEvent(
            id: idHex,
            pubkey: pubkeyHex,
            createdAt: createdAt,
            kind: kind,
            tags: tags,
            content: content,
            sig: Data(sigBytes).hexEncoded()
        )
    }

    public static func publicKeyHex(nsecHex: String) throws -> String {
        guard let secretBytes = secretKeyBytes(nsecHex: nsecHex) else {
            throw NostrSigningError.invalidNsec
        }

        let context = Secp256k1Nostr.context
        var keypair = secp256k1_keypair()
        var xonlyPubKey = secp256k1_xonly_pubkey()
        var keyParity: Int32 = 0
        var pubkeyBytes = [UInt8](repeating: 0, count: 32)
        guard secp256k1_keypair_create(context, &keypair, secretBytes) == 1,
              secp256k1_keypair_xonly_pub(context, &xonlyPubKey, &keyParity, &keypair) == 1,
              secp256k1_xonly_pubkey_serialize(context, &pubkeyBytes, &xonlyPubKey) == 1
        else {
            throw NostrSigningError.invalidNsec
        }
        return Data(pubkeyBytes).hexEncoded()
    }

    private static func secretKeyBytes(nsecHex: String) -> [UInt8]? {
        guard nsecHex.count == 64,
              let data = Data(hexEncoded: nsecHex),
              data.count == 32
        else { return nil }

        let bytes = [UInt8](data)
        guard secp256k1_ec_seckey_verify(Secp256k1Nostr.context, bytes) == 1 else {
            return nil
        }
        return bytes
    }
}

extension Data {
    init?(hexEncoded hex: String) {
        guard hex.count.isMultiple(of: 2) else { return nil }

        var data = Data(capacity: hex.count / 2)
        var idx = hex.startIndex
        while idx < hex.endIndex {
            let next = hex.index(idx, offsetBy: 2)
            guard let byte = UInt8(hex[idx..<next], radix: 16) else { return nil }
            data.append(byte)
            idx = next
        }
        self = data
    }

    func hexEncoded() -> String {
        map { String(format: "%02x", $0) }.joined()
    }
}
