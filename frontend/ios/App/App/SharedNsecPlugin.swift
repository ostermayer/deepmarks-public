// Capacitor plugin: SharedNsec — lets the JS app write the user's
// nsec into the shared Keychain access group so the DeepmarksShare
// extension can read it and sign + POST /publish without waiting
// for the main app to foreground.
//
// JS contract (frontend/src/lib/native/shared-nsec.ts):
//   SharedNsec.save({ nsecHex })  → writes to Keychain (overwrite)
//   SharedNsec.load()             → { nsecHex: string | null }
//   SharedNsec.clear()            → wipes
//
// The plugin runs in the main app process; the share extension
// reads the same Keychain item directly via KeychainSharedStore
// (no Capacitor in the extension target).

import Capacitor
import Foundation

@objc(SharedNsecPlugin)
public class SharedNsecPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SharedNsecPlugin"
    public let jsName = "SharedNsec"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "save", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "load", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise),
    ]

    @objc func save(_ call: CAPPluginCall) {
        guard let hex = call.getString("nsecHex"),
              hex.range(of: "^[0-9a-fA-F]{64}$", options: .regularExpression) != nil
        else {
            call.reject("nsecHex must be 64-char hex")
            return
        }
        let ok = KeychainSharedStore.saveNsecHex(hex.lowercased())
        if ok {
            call.resolve()
        } else {
            call.reject("keychain save failed")
        }
    }

    @objc func load(_ call: CAPPluginCall) {
        let hex = KeychainSharedStore.loadNsecHex()
        call.resolve(["nsecHex": hex as Any])
    }

    @objc func clear(_ call: CAPPluginCall) {
        let ok = KeychainSharedStore.clearNsec()
        if ok {
            call.resolve()
        } else {
            call.reject("keychain clear failed")
        }
    }
}
