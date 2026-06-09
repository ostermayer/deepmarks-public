//
//  SafariWebExtensionHandler.swift
//  Shared (Extension)
//
//  Native messaging host for the Deepmarks Safari Web Extension.
//
//  Receives JSON messages from the extension's JS via
//  `browser.runtime.sendNativeMessage`, performs Keychain reads /
//  writes / deletes, returns the result as JSON.
//
//  Protocol (matches src/lib/nsec-store.ts KeychainNsecStore — JS side
//  is the v1.1.0 follow-up; this Swift handler is dormant until that
//  lands):
//
//      → { op: "get" }
//      ← { ok: true, account?: { schemaVersion, nsecHex, pubkey, signedInAt } }
//
//      → { op: "set", account: { schemaVersion, nsecHex, pubkey, signedInAt } }
//      ← { ok: true }
//
//      → { op: "clear" }
//      ← { ok: true }
//
//      On error from any op:
//      ← { ok: false, error: "<reason>" }
//
//  Why the rewrite:
//    The original draft (browser-extension/safari/KeychainBridge.swift)
//    extended `SFSafariExtensionHandler`, the legacy Safari App
//    Extension API. Modern Safari Web Extensions use
//    `NSExtensionRequestHandling`, where messages arrive via
//    `request.userInfo[SFExtensionMessageKey]` and replies go back via
//    `context.completeRequest(returningItems:completionHandler:)`.
//    This file is the modern-API port — same Keychain semantics, right
//    transport.
//
//  Required project setup (Xcode):
//    • Both extension targets need the **Keychain Sharing** capability
//      with group `org.deepmarks.extension.keychain` (managed via the
//      target's *.entitlements file). The macOS extension's
//      entitlements ships pre-configured; iOS needs the capability
//      added via Xcode's "Signing & Capabilities" tab on first build
//      (this auto-creates iOS (Extension)/Deepmarks.entitlements).
//

import SafariServices
import Foundation

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    // MARK: - Keychain identity

    /// The `kSecAttrService` for our keychain item. One service per
    /// extension; one account per nsec the user has stored.
    private static let keychainService = "org.deepmarks.extension"
    /// Single-account model for now — there's at most one signed-in
    /// nsec per browser profile. If we ever support account switching
    /// inside the extension, this becomes a parameter.
    private static let keychainAccount = "nsec"
    /// The shared access group declared in *.entitlements. Both the
    /// extension and any future host-app code see the same item.
    private static let keychainAccessGroup = "org.deepmarks.extension.keychain"

    // MARK: - NSExtensionRequestHandling

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let message: Any?
        if #available(iOS 15.0, macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }

        let reply = handle(message: message)

        let response = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            response.userInfo = [SFExtensionMessageKey: reply]
        } else {
            response.userInfo = ["message": reply]
        }
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }

    /// Pure dispatch — takes the parsed message dict, returns the
    /// reply dict. Splitting this out keeps the keychain logic
    /// testable without an NSExtensionContext.
    private func handle(message: Any?) -> [String: Any] {
        guard let info = message as? [String: Any], let op = info["op"] as? String else {
            return [
                "ok": false,
                "error": "malformed message — expected { op: 'get' | 'set' | 'clear' }",
            ]
        }

        switch op {
        case "get":
            do {
                if let account = try Self.readAccount() {
                    return ["ok": true, "account": account]
                } else {
                    return ["ok": true]
                }
            } catch {
                return ["ok": false, "error": "keychain read failed: \(error.localizedDescription)"]
            }

        case "set":
            guard let account = info["account"] as? [String: Any] else {
                return ["ok": false, "error": "missing account in 'set' message"]
            }
            do {
                try Self.writeAccount(account)
                return ["ok": true]
            } catch {
                return ["ok": false, "error": "keychain write failed: \(error.localizedDescription)"]
            }

        case "clear":
            do {
                try Self.deleteAccount()
                return ["ok": true]
            } catch {
                return ["ok": false, "error": "keychain delete failed: \(error.localizedDescription)"]
            }

        default:
            return ["ok": false, "error": "unknown op: \(op)"]
        }
    }

    // MARK: - Keychain primitives
    //
    // Static so they can be called without instantiating the handler
    // — useful if a future host-app screen wants to surface a "you're
    // signed in as ..." status without touching the extension.

    private static func writeAccount(_ account: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: account, options: [])
        // SecItemAdd refuses to overwrite an existing item with the
        // same primary keys, so delete-then-add is the simple upsert
        // pattern. ItemNotFound on the delete is expected on first
        // write and ignored.
        try? deleteAccount()
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecAttrAccessGroup as String: keychainAccessGroup,
            kSecValueData as String: data,
            // After-first-unlock so the popup can read the nsec on
            // app cold-start without forcing a biometric prompt every
            // time the user opens the toolbar icon. iOS still gates
            // the read with Touch ID / Face ID when the device is
            // configured for it — system policy enforces that, no
            // extra work needed here.
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
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecAttrAccessGroup as String: keychainAccessGroup,
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
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecAttrAccessGroup as String: keychainAccessGroup,
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
    }
}
