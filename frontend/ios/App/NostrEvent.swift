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

public enum NostrNip44Error: Error {
    case invalidKey
    case ecdhFailed
    case invalidPlaintextSize
    case invalidConversationKey
    case invalidNonce
}

public enum NostrNip44 {
    private static let version: UInt8 = 2
    private static let salt = Data("nip44-v2".utf8)
    private static let privateItemPrefix = "deepmarks-private-item:"

    public static func privateItemName(for url: String) -> String {
        let digest = SHA256.hash(data: Data(url.utf8))
        return privateItemPrefix + Data(digest).hexEncoded()
    }

    public static func conversationKey(nsecHex: String, peerPubkeyHex: String) throws -> Data {
        let sharedX = try sharedSecretX(nsecHex: nsecHex, peerPubkeyHex: peerPubkeyHex)
        return hmacSha256(key: salt, data: sharedX)
    }

    public static func encrypt(_ plaintext: String, conversationKey: Data) throws -> String {
        let nonce = try Data(Secp256k1Nostr.randomBytes(count: 32))
        return try encrypt(plaintext, conversationKey: conversationKey, nonce: nonce)
    }

    public static func encrypt(_ plaintext: String, conversationKey: Data, nonce: Data) throws -> String {
        guard conversationKey.count == 32 else { throw NostrNip44Error.invalidConversationKey }
        guard nonce.count == 32 else { throw NostrNip44Error.invalidNonce }
        let keys = try messageKeys(conversationKey: conversationKey, nonce: nonce)
        let padded = try pad(plaintext)
        let ciphertext = chacha20(key: keys.chachaKey, nonce: keys.chachaNonce, input: padded)
        var macInput = Data()
        macInput.append(nonce)
        macInput.append(ciphertext)
        let mac = hmacSha256(key: keys.hmacKey, data: macInput)
        var payload = Data([version])
        payload.append(nonce)
        payload.append(ciphertext)
        payload.append(mac)
        return payload.base64EncodedString()
    }

    private static func sharedSecretX(nsecHex: String, peerPubkeyHex: String) throws -> Data {
        guard nsecHex.count == 64,
              peerPubkeyHex.range(of: "^[0-9a-fA-F]{64}$", options: .regularExpression) != nil,
              let secret = Data(hexEncoded: nsecHex).map(Array.init),
              secret.count == 32,
              secp256k1_ec_seckey_verify(Secp256k1Nostr.context, secret) == 1,
              let pubkeyX = Data(hexEncoded: peerPubkeyHex),
              pubkeyX.count == 32
        else {
            throw NostrNip44Error.invalidKey
        }

        var compressed = [UInt8](repeating: 0, count: 33)
        compressed[0] = 0x02
        compressed.replaceSubrange(1..<33, with: [UInt8](pubkeyX))

        var pubkey = secp256k1_pubkey()
        let parsed = compressed.withUnsafeBufferPointer { buffer in
            secp256k1_ec_pubkey_parse(Secp256k1Nostr.context, &pubkey, buffer.baseAddress!, buffer.count)
        }
        guard parsed == 1 else { throw NostrNip44Error.invalidKey }

        var output = [UInt8](repeating: 0, count: 32)
        let result = secret.withUnsafeBufferPointer { secretBuffer in
            output.withUnsafeMutableBufferPointer { outputBuffer in
                secp256k1_ecdh(
                    Secp256k1Nostr.context,
                    outputBuffer.baseAddress!,
                    &pubkey,
                    secretBuffer.baseAddress!,
                    ecdhCopyX,
                    nil
                )
            }
        }
        guard result == 1 else { throw NostrNip44Error.ecdhFailed }
        return Data(output)
    }

    private static let ecdhCopyX: secp256k1_ecdh_hash_function = { output, x32, _, _ in
        guard let output, let x32 else { return 0 }
        output.update(from: x32, count: 32)
        return 1
    }

    private static func messageKeys(conversationKey: Data, nonce: Data) throws -> (chachaKey: Data, chachaNonce: Data, hmacKey: Data) {
        let expanded = try hkdfExpand(prk: conversationKey, info: nonce, length: 76)
        return (
            expanded.subdata(in: 0..<32),
            expanded.subdata(in: 32..<44),
            expanded.subdata(in: 44..<76)
        )
    }

    private static func pad(_ plaintext: String) throws -> Data {
        let raw = Data(plaintext.utf8)
        let len = raw.count
        guard len >= 1 && len <= 65_535 else { throw NostrNip44Error.invalidPlaintextSize }
        var padded = Data(repeating: 0, count: 2 + calcPaddedLen(len))
        padded[0] = UInt8((len >> 8) & 0xff)
        padded[1] = UInt8(len & 0xff)
        padded.replaceSubrange(2..<(2 + len), with: raw)
        return padded
    }

    private static func calcPaddedLen(_ len: Int) -> Int {
        if len <= 32 { return 32 }
        var nextPower = 1
        while nextPower < len { nextPower <<= 1 }
        let chunk = nextPower <= 256 ? 32 : nextPower / 8
        return chunk * (((len - 1) / chunk) + 1)
    }

    private static func hmacSha256(key: Data, data: Data) -> Data {
        let symmetricKey = SymmetricKey(data: key)
        return Data(HMAC<SHA256>.authenticationCode(for: data, using: symmetricKey))
    }

    private static func hkdfExpand(prk: Data, info: Data, length: Int) throws -> Data {
        guard length >= 0 && length <= 255 * 32 else { throw NostrNip44Error.invalidPlaintextSize }
        var out = Data()
        var previous = Data()
        var counter: UInt8 = 1
        while out.count < length {
            var input = Data()
            input.append(previous)
            input.append(info)
            input.append(contentsOf: [counter])
            previous = hmacSha256(key: prk, data: input)
            out.append(previous)
            counter &+= 1
        }
        return Data(out.prefix(length))
    }

    private static func chacha20(key: Data, nonce: Data, input: Data) -> Data {
        let keyBytes = [UInt8](key)
        let nonceBytes = [UInt8](nonce)
        let inputBytes = [UInt8](input)
        var output = [UInt8](repeating: 0, count: inputBytes.count)
        var counter: UInt32 = 0
        for pos in stride(from: 0, to: inputBytes.count, by: 64) {
            let block = chachaBlock(key: keyBytes, nonce: nonceBytes, counter: counter)
            let take = min(64, inputBytes.count - pos)
            for i in 0..<take {
                output[pos + i] = inputBytes[pos + i] ^ block[i]
            }
            counter &+= 1
        }
        return Data(output)
    }

    private static func chachaBlock(key: [UInt8], nonce: [UInt8], counter: UInt32) -> [UInt8] {
        var state = [UInt32](repeating: 0, count: 16)
        state[0] = 0x61707865
        state[1] = 0x3320646e
        state[2] = 0x79622d32
        state[3] = 0x6b206574
        for i in 0..<8 {
            state[4 + i] = littleEndianToUInt32(key, offset: i * 4)
        }
        state[12] = counter
        state[13] = littleEndianToUInt32(nonce, offset: 0)
        state[14] = littleEndianToUInt32(nonce, offset: 4)
        state[15] = littleEndianToUInt32(nonce, offset: 8)

        var working = state
        for _ in 0..<10 {
            quarterRound(&working, 0, 4, 8, 12)
            quarterRound(&working, 1, 5, 9, 13)
            quarterRound(&working, 2, 6, 10, 14)
            quarterRound(&working, 3, 7, 11, 15)
            quarterRound(&working, 0, 5, 10, 15)
            quarterRound(&working, 1, 6, 11, 12)
            quarterRound(&working, 2, 7, 8, 13)
            quarterRound(&working, 3, 4, 9, 14)
        }

        var out = [UInt8](repeating: 0, count: 64)
        for i in 0..<16 {
            writeLittleEndian(working[i] &+ state[i], into: &out, offset: i * 4)
        }
        return out
    }

    private static func quarterRound(_ x: inout [UInt32], _ a: Int, _ b: Int, _ c: Int, _ d: Int) {
        x[a] = x[a] &+ x[b]; x[d] = rotateLeft(x[d] ^ x[a], by: 16)
        x[c] = x[c] &+ x[d]; x[b] = rotateLeft(x[b] ^ x[c], by: 12)
        x[a] = x[a] &+ x[b]; x[d] = rotateLeft(x[d] ^ x[a], by: 8)
        x[c] = x[c] &+ x[d]; x[b] = rotateLeft(x[b] ^ x[c], by: 7)
    }

    private static func rotateLeft(_ value: UInt32, by amount: UInt32) -> UInt32 {
        return (value << amount) | (value >> (32 - amount))
    }

    private static func littleEndianToUInt32(_ bytes: [UInt8], offset: Int) -> UInt32 {
        return UInt32(bytes[offset]) |
            (UInt32(bytes[offset + 1]) << 8) |
            (UInt32(bytes[offset + 2]) << 16) |
            (UInt32(bytes[offset + 3]) << 24)
    }

    private static func writeLittleEndian(_ value: UInt32, into out: inout [UInt8], offset: Int) {
        out[offset] = UInt8(value & 0xff)
        out[offset + 1] = UInt8((value >> 8) & 0xff)
        out[offset + 2] = UInt8((value >> 16) & 0xff)
        out[offset + 3] = UInt8((value >> 24) & 0xff)
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
