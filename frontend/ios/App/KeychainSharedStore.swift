// Shared Keychain store for the user's nsec.
//
// Both the main app target and the DeepmarksShare extension link
// this file. The `keychain-access-groups` entitlement on both
// binaries declares one shared group:
//     $(AppIdentifierPrefix)org.deepmarks.shared
// A nsec saved by the main app (via the SharedNsec Capacitor plugin
// during sign-in) is therefore readable from the share extension —
// that's what lets the extension sign + POST /publish without
// waiting for the main app to foreground.
//
// We deliberately omit `kSecAttrAccessGroup` from the SecItem*
// queries. With exactly one access group declared in entitlements,
// iOS uses that group automatically, which sidesteps the
// "$(AppIdentifierPrefix)" resolution problem (the Xcode-substituted
// team-prefix differs between local builds and TestFlight / App
// Store builds, and hard-coding it in source is brittle).
//
// kSecAttrAccessibleAfterFirstUnlock — share extensions launch in
// the background and may run before the user has foregrounded the
// device since boot. afterFirstUnlock is the only level that
// survives "device just rebooted but already unlocked once".

import Foundation
import Security

public enum KeychainSharedStore {
    public static let service = "org.deepmarks.nsec"
    public static let account = "active"

    /// Store the user's nsec as raw hex (32 bytes → 64 hex chars).
    /// Returns true on success. Overwrites any existing entry.
    @discardableResult
    public static func saveNsecHex(_ hex: String) -> Bool {
        guard let data = hex.data(using: .utf8) else { return false }
        let deleteQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(deleteQuery as CFDictionary)

        let addQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        return SecItemAdd(addQuery as CFDictionary, nil) == errSecSuccess
    }

    /// Read the user's nsec as hex, or nil if not stored. Caller MUST
    /// NOT log the returned string.
    public static func loadNsecHex() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess,
              let data = item as? Data,
              let hex = String(data: data, encoding: .utf8)
        else { return nil }
        return hex
    }

    /// Remove the stored nsec. Idempotent — missing entry isn't an error.
    @discardableResult
    public static func clearNsec() -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }
}
