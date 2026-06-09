// Build-time flags that gate UX between distribution channels.
//
// Same shape as browser-extension/src/lib/build-flags.ts. We ship the
// SvelteKit frontend in three forms:
//
//   - Web (deepmarks.org)              — full functionality
//   - Android-via-Capacitor             — full functionality
//   - iOS-via-Capacitor (APPLE_BUILD)  — payment surfaces stripped
//
// Apple's IAP guideline (3.1.1) bans in-app payment UI for digital
// content/services unless they go through StoreKit, and 3.1.5(a)
// disallows Bitcoin specifically as a payment rail for virtual goods.
// Our lifetime upgrade is one. Strategy:
// Netflix model. Users who pay on the website (or subscribed before
// installing) see unlocked features; iOS users who tap an
// archive-only feature see "only available for premium members" and
// no link out — they discover the upgrade flow elsewhere if at all.
//
// NWC outbound (zaps to other users) stays in every build — that's
// P2P tipping, not an in-app purchase, and Damus has the precedent
// for keeping it on iOS.
//
// Set with `VITE_APPLE_BUILD=1` at build time. Read once here so the
// branches are tree-shakeable: every reference becomes a literal
// boolean at bundle time, and minification drops the unused branch.

/** True for the App-Store-bound iOS build. When true:
 *
 *   - /app/upgrade route is hidden / redirects to /app/bookmarks
 *   - Sidebar "upgrade →" CTA disappears
 *   - Footer "pricing" link disappears
 *   - ArchiveDialog is replaced with a "premium only" notice for
 *     non-lifetime users (no link out)
 *   - Paid add-ons and hosted-checkout entry points are hidden
 *
 *  Lifetime members see the same archive entitlements as on web —
 *  the API tells the app they're a member, the UI unlocks. There is
 *  no payment UI in the app for them to interact with regardless.
 *
 *  Note for reviewers reading the source: this constant is set at
 *  build time, not runtime. The iOS bundle never contains the
 *  upgrade-flow code paths; minification strips them. The web bundle
 *  ships as today.
 */
export const IS_APPLE_BUILD: boolean =
  import.meta.env.VITE_APPLE_BUILD === '1';
