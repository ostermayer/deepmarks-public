// Build-time flags that gate UX between distribution channels.
//
// We can't ship the same bundle to every store: Apple's IAP guideline
// (Section 3.1.1) bans payment surfaces inside an app for digital
// content unless they go through StoreKit. Our lifetime-upgrade flow is
// Bitcoin-native, so the Safari (and future iOS-native) build removes
// that surface entirely.
//
// Set with `VITE_APPLE_BUILD=1` at build time. Read once here so the
// branches are tree-shakeable: every reference to `IS_APPLE_BUILD`
// becomes a literal boolean at bundle time, and minification drops
// the unused branch.

/** True for the App-Store-bound build (Safari extension and future
 *  iOS standalone). When true:
 *
 *   - Archive controls are shown only to lifetime members. Their
 *     archive entitlement is verified at launch and granted server-side.
 *   - Lifetime upgrade UI (the BTCPay checkout panel in Settings) is
 *     never rendered.
 *   - NWC stays wired for outbound zaps (a tipping flow Apple has
 *     historically allowed for content; see the Damus precedent).
 *
 *  Users in this build who want the upgrade learn about it on
 *  deepmarks.org and complete the flow there. The extension never
 *  links them to the upgrade page — that link itself would be a
 *  policy footgun under Apple's "external linking" rules.
 */
export const IS_APPLE_BUILD: boolean =
  import.meta.env.VITE_APPLE_BUILD === '1';
