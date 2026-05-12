import type { CapacitorConfig } from '@capacitor/cli';

// Capacitor wrapper config — wraps the SvelteKit static build into
// iOS + Android native shells.
//
// Build flow:
//   npm run build:apple      → SvelteKit builds with VITE_APPLE_BUILD=1 → build/
//   npx cap sync ios         → copies build/ into ios/App/App/public/
//   open ios/App/App.xcworkspace → Run in Xcode
//
//   npm run build            → SvelteKit builds for web/Android → build/
//   npx cap sync android     → copies build/ into android/app/src/main/assets/public/
//   npx cap open android     → opens in Android Studio
//
// We intentionally don't ship a single bundle for both platforms:
// Apple needs the payment-surface-stripped variant; Android can run
// the same build the website uses. Same SvelteKit source either way.

const config: CapacitorConfig = {
  appId: 'org.deepmarks.app',
  appName: 'Deepmarks',
  webDir: 'build',
  // Custom URL scheme for the iOS Share Extension + Android
  // Intent Filter — both deep-link into deepmarks://save?url=…
  // which the SvelteKit /app/save route handles via the
  // appUrlOpen listener in src/lib/native/deep-links.ts.
  ios: {
    scheme: 'Deepmarks',
    contentInset: 'always',
  },
  android: {
    allowMixedContent: false,
  },
  // Capacitor's CLI doesn't manage the Associated Domains
  // capability or the Android App Links intent-filter — those
  // live inline in the native projects (App.entitlements +
  // AndroidManifest.xml). The /.well-known/ files that those
  // capabilities point at live in frontend/static/ and ship
  // with the SvelteKit build.
  // The webview talks to api.deepmarks.org and the configured Nostr
  // relays from inside the app. No localhost dev server reference at
  // runtime — the bundle is fully static.
  server: {
    androidScheme: 'https',
    iosScheme: 'capacitor',
  },
};

export default config;
