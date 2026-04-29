// KeychainBridge.swift — Safari Web Extension native messaging host.
//
// Receives JSON messages from the extension popup / background via
// `browser.runtime.sendNativeMessage`, performs Keychain reads /
// writes / deletes, returns the result as JSON.
//
// Add this file to the `Deepmarks Extension` target in Xcode (NOT
// the host-app target). Capabilities → Keychain Sharing must include
// `org.deepmarks.extension.keychain` so this code and any future
// host-app code see the same keychain item.
//
// Message protocol (matches src/lib/nsec-store.ts KeychainNsecStore):
//   { op: "get" }         → { ok, account?: { schemaVersion, nsecHex, pubkey, signedInAt } }
//   { op: "set", account: {...} } → { ok }
//   { op: "clear" }       → { ok }
// On error: { ok: false, error: string }

import Foundation
import SafariServices

class KeychainBridge: SFSafariExtensionHandler {
    private static let service = "org.deepmarks.extension"
    private static let account = "nsec"
    private static let accessGroup = "org.deepmarks.extension.keychain"

    override func messageReceived(
        withName messageName: String,
        from page: SFSafariPage,
        userInfo: [String: Any]?
    ) {
        // Single message channel — `messageName` should be "keychain".
        // The userInfo carries the actual op and payload.
        guard messageName == "keychain", let info = userInfo else {
            replyError("unknown message", to: page)
            return
        }
        let op = info["op"] as? String ?? ""

        switch op {
        case "get":
            do {
                if let account = try Self.readAccount() {
                    replyOk(["account": account], to: page)
                } else {
                    replyOk([:], to: page)
                }
            } catch {
                replyError("keychain read failed: \(error)", to: page)
            }

        case "set":
            guard let account = info["account"] as? [String: Any] else {
                replyError("missing account", to: page)
                return
            }
            do {
                try Self.writeAccount(account)
                replyOk([:], to: page)
            } catch {
                replyError("keychain write failed: \(error)", to: page)
            }

        case "clear":
            do {
                try Self.deleteAccount()
                replyOk([:], to: page)
            } catch {
                replyError("keychain delete failed: \(error)", to: page)
            }

        default:
            replyError("unknown op: \(op)", to: page)
        }
    }

    // MARK: - Keychain primitives

    private static func writeAccount(_ account: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: account, options: [])
        // Delete first; SecItemAdd refuses to overwrite an existing
        // item with the same primary keys.
        try? deleteAccount()
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: Self.account,
            kSecAttrAccessGroup as String: accessGroup,
            kSecValueData as String: data,
            // After-first-unlock so the popup can read on app cold-start
            // without prompting biometrics every time. iOS adds Touch
            // ID / Face ID prompt automatically when the device is
            // configured for it.
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
    }

    private static func readAccount() throws -> [String: Any]? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: accessGroup,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
        return try JSONSerialization.jsonObject(with: data, options: []) as? [String: Any]
    }

    private static func deleteAccount() throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: accessGroup,
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
    }

    // MARK: - Reply helpers

    private func replyOk(_ extra: [String: Any], to page: SFSafariPage) {
        var payload = extra
        payload["ok"] = true
        page.dispatchMessageToScript(withName: "keychain-reply", userInfo: payload)
    }

    private func replyError(_ message: String, to page: SFSafariPage) {
        page.dispatchMessageToScript(
            withName: "keychain-reply",
            userInfo: ["ok": false, "error": message]
        )
    }
}
