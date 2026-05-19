import UIKit
import Capacitor
import Security
import LocalAuthentication

@objc(DeepmarksBridgeViewController)
class DeepmarksBridgeViewController: CAPBridgeViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        webView?.scrollView.minimumZoomScale = 1.0
        webView?.scrollView.maximumZoomScale = 1.0
        webView?.scrollView.bouncesZoom = false
        webView?.scrollView.pinchGestureRecognizer?.isEnabled = false
        // iOS 16.4+ requires apps to opt in to WKWebView inspection.
        // Capacitor leaves this off by default for Release builds. We
        // ship development + adhoc builds where attaching Safari Web
        // Inspector to the live app is useful (debugging the share
        // drain, durable-publish queue, NIP-44 decryption, etc.) —
        // leave it on. The App Store review build can switch this
        // back to a compile-time flag later if needed.
        if #available(iOS 16.4, *) {
            webView?.isInspectable = true
        }
    }

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(DeepmarksSecureStorePlugin())
        bridge?.registerPluginInstance(SharedNsecPlugin())
    }
}

@objc(DeepmarksSecureStorePlugin)
class DeepmarksSecureStorePlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "DeepmarksSecureStorePlugin"
    let jsName = "DeepmarksSecureStore"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "canAuthenticateBiometric", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "authenticateBiometric", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPendingSharedBookmark", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removePendingSharedBookmark", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeUserTags", returnType: CAPPluginReturnPromise)
    ]

    private let service = "org.deepmarks.app.secure-store"
    private let appGroupIdentifier = "group.org.deepmarks.app.shared"
    private let pendingSharesKey = "deepmarks-pending-shares-v1"
    private let userTagsKey = "deepmarks-user-tags-v1"

    @objc func get(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("key is required")
            return
        }
        do {
            let value = try readValue(key: key)
            call.resolve(["value": value ?? NSNull()])
        } catch {
            call.reject(error.localizedDescription)
        }
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("key is required")
            return
        }
        guard let value = call.getString("value") else {
            call.reject("value is required")
            return
        }
        do {
            try writeValue(key: key, value: value)
            call.resolve()
        } catch {
            call.reject(error.localizedDescription)
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("key is required")
            return
        }
        do {
            try deleteValue(key: key)
            call.resolve()
        } catch {
            call.reject(error.localizedDescription)
        }
    }

    @objc func canAuthenticateBiometric(_ call: CAPPluginCall) {
        let context = LAContext()
        var error: NSError?
        let available = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
        call.resolve([
            "available": available,
            "biometryType": biometryTypeName(context.biometryType)
        ])
    }

    @objc func authenticateBiometric(_ call: CAPPluginCall) {
        let reason = call.getString("reason") ?? "Unlock Deepmarks"
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
            call.reject(error?.localizedDescription ?? "biometric unlock is unavailable")
            return
        }
        context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { success, authError in
            DispatchQueue.main.async {
                if success {
                    call.resolve(["authenticated": true])
                } else {
                    call.reject(authError?.localizedDescription ?? "biometric unlock failed")
                }
            }
        }
    }

    @objc func getPendingSharedBookmark(_ call: CAPPluginCall) {
        guard let defaults = UserDefaults(suiteName: appGroupIdentifier) else {
            call.resolve(["bookmark": NSNull()])
            return
        }
        // Cross-process: the Share Extension wrote to this same suite
        // from a separate process. Force a re-read from disk so we
        // don't return a stale in-memory cache that predates the
        // extension's write. `synchronize` is deprecated but is still
        // the documented way to flush + re-read the on-disk plist for
        // App Group UserDefaults shared with an extension.
        defaults.synchronize()
        let id = call.getString("id")
        let shares = loadPendingShares(defaults: defaults)
        let bookmark = shares.first { share in
            guard let id, !id.isEmpty else { return true }
            return share["id"] == id
        }
        call.resolve(["bookmark": bookmark ?? NSNull()])
    }

    @objc func writeUserTags(_ call: CAPPluginCall) {
        // The main app pushes the signed-in user's most-used tags to the
        // shared AppGroup so the share extension can offer autocomplete
        // without needing to crack open WKWebView state or hit the
        // network. Frequency-ordered, capped to a reasonable size.
        let tags = call.getArray("tags") as? [String] ?? []
        guard let defaults = UserDefaults(suiteName: appGroupIdentifier) else {
            call.resolve()
            return
        }
        let cleaned = tags
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && $0.count <= 48 }
        defaults.set(Array(cleaned.prefix(400)), forKey: userTagsKey)
        defaults.synchronize()
        call.resolve()
    }

    @objc func removePendingSharedBookmark(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else {
            call.reject("id is required")
            return
        }
        guard let defaults = UserDefaults(suiteName: appGroupIdentifier) else {
            call.resolve()
            return
        }
        let next = loadPendingShares(defaults: defaults).filter { $0["id"] != id }
        do {
            let data = try JSONSerialization.data(withJSONObject: next, options: [])
            defaults.set(data, forKey: pendingSharesKey)
            defaults.synchronize()
            call.resolve()
        } catch {
            call.reject(error.localizedDescription)
        }
    }

    private func baseQuery(key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key
        ]
    }

    private func writeValue(key: String, value: String) throws {
        try deleteValue(key: key)
        var query = baseQuery(key: key)
        query[kSecValueData as String] = Data(value.utf8)
        query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw keychainError(status) }
    }

    private func readValue(key: String) throws -> String? {
        var query = baseQuery(key: key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw keychainError(status) }
        guard let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func deleteValue(key: String) throws {
        let status = SecItemDelete(baseQuery(key: key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw keychainError(status)
        }
    }

    private func keychainError(_ status: OSStatus) -> NSError {
        let message = SecCopyErrorMessageString(status, nil) as String? ?? "Keychain error \(status)"
        return NSError(domain: "DeepmarksSecureStore", code: Int(status), userInfo: [
            NSLocalizedDescriptionKey: message
        ])
    }

    private func loadPendingShares(defaults: UserDefaults) -> [[String: String]] {
        guard
            let data = defaults.data(forKey: pendingSharesKey),
            let decoded = try? JSONSerialization.jsonObject(with: data) as? [[String: String]]
        else {
            return []
        }
        return decoded
    }

    private func biometryTypeName(_ type: LABiometryType) -> String {
        switch type {
        case .faceID:
            return "Face ID"
        case .touchID:
            return "Touch ID"
        case .opticID:
            return "Optic ID"
        default:
            return "biometrics"
        }
    }
}

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}
