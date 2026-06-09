//
//  ShareViewController.swift
//  DeepmarksShare
//
//  Receives shared URLs from any iOS app's share sheet (Safari,
//  Mail, Messages, …) and forwards them to the host app via the
//  custom URL scheme `deepmarks://save?url=…`.
//
//  Drop this file into the DeepmarksShare target after creating it
//  via Xcode → File → New → Target → Share Extension. See
//  SHARE-EXTENSION-SETUP.md for the full one-time setup.
//
//  No UI: the share-sheet preview is the only thing the user sees
//  before the host app takes over. We complete the extension's
//  request right after opening the host app so the share sheet
//  dismisses cleanly.

import UIKit
import Social
import MobileCoreServices
import UniformTypeIdentifiers

class ShareViewController: SLComposeServiceViewController {

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        extractSharedURL { url in
            DispatchQueue.main.async {
                if let url = url {
                    self.openInHostApp(sharedUrl: url)
                }
                self.extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
            }
        }
    }

    /// Walk the share extension's input items looking for the first
    /// URL the user shared. Browsers attach the URL as a public.url
    /// type provider; some apps additionally attach a public.text
    /// representation that may also contain a URL — we prefer the
    /// public.url path and fall back to text only when no provider
    /// hands us a URL directly.
    private func extractSharedURL(completion: @escaping (URL?) -> Void) {
        guard
            let item = extensionContext?.inputItems.first as? NSExtensionItem,
            let attachments = item.attachments
        else {
            completion(nil)
            return
        }

        let urlType = UTType.url.identifier
        let textTypes = [UTType.plainText.identifier, UTType.text.identifier]

        // First pass: ask each provider for a real URL.
        for attachment in attachments {
            if attachment.hasItemConformingToTypeIdentifier(urlType) {
                attachment.loadItem(forTypeIdentifier: urlType, options: nil) { (data, _) in
                    if let url = data as? URL {
                        completion(url)
                    } else if let str = data as? String, let url = URL(string: str) {
                        completion(url)
                    } else {
                        completion(nil)
                    }
                }
                return
            }
        }

        // Fallback: look in plaintext for a URL — covers apps that
        // share "Title\nhttps://example.com/article" as a single
        // text item.
        for attachment in attachments {
            for textType in textTypes {
                if attachment.hasItemConformingToTypeIdentifier(textType) {
                    attachment.loadItem(forTypeIdentifier: textType, options: nil) { (data, _) in
                        completion(self.extractFirstWebURL(from: (data as? String) ?? ""))
                    }
                    return
                }
            }
        }

        completion(nil)
    }

    private func extractFirstWebURL(from text: String) -> URL? {
        text
            .split(whereSeparator: { $0.isWhitespace })
            .lazy
            .map { $0.trimmingCharacters(in: CharacterSet(charactersIn: ".,;:!?)\"]}'")) }
            .compactMap { URL(string: String($0)) }
            .first { ($0.scheme == "http" || $0.scheme == "https") }
    }

    /// Open the host app with deepmarks://save?url=<encoded URL>.
    /// Walks the responder chain to find a UIResponder that can call
    /// `open(_:)` — the modern API for share extensions, since
    /// `extensionContext.open()` is async-only and `UIApplication`
    /// is unavailable from within an extension.
    private func openInHostApp(sharedUrl: URL) {
        var components = URLComponents()
        components.scheme = "deepmarks"
        components.host = "save"
        components.queryItems = [URLQueryItem(name: "url", value: sharedUrl.absoluteString)]
        guard let appUrl = components.url else { return }
        let selector = sel_registerName("openURL:")
        var responder: UIResponder? = self
        while let r = responder {
            if r.responds(to: selector) {
                _ = r.perform(selector, with: appUrl)
                return
            }
            responder = r.next
        }
    }

    // SLComposeServiceViewController requires this; we don't show
    // a compose view so it's never called, but the protocol wants
    // a non-nil return.
    override func isContentValid() -> Bool { return true }
    override func didSelectPost() { /* unused — handled in viewDidAppear */ }
    override func configurationItems() -> [Any]! { return [] }
}
