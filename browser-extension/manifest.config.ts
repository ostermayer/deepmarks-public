// Manifest factory — produces an MV3 manifest with per-browser tweaks.
//
// Chrome / Edge / Brave / Arc all consume the base manifest.
// Firefox needs `browser_specific_settings.gecko.id` and converts the
// service-worker entry to background.scripts under the hood (handled by
// @crxjs/vite-plugin's firefox preset).

import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json';

const browser = (process.env.BROWSER as 'chrome' | 'firefox') ?? 'chrome';

export default defineManifest({
  manifest_version: 3,
  name: 'Deepmarks',
  version: pkg.version,
  description: pkg.description,
  // Toolbar icon — Chrome MV3 doesn't reliably render SVG for the
  // action icon (the toolbar slot wants raster at exact pixel sizes
  // for crisp display at 1x and 2x scaling). PNGs are generated from
  // public/pennant.svg via `sips`. Re-run if the source SVG changes.
  icons: {
    16: 'icons/pennant-16.png',
    32: 'icons/pennant-32.png',
    48: 'icons/pennant-48.png',
    128: 'icons/pennant-128.png',
  },
  action: {
    default_title: 'Deepmarks — save bookmark',
    default_popup: 'src/popup/index.html',
    default_icon: {
      16: 'icons/pennant-16.png',
      32: 'icons/pennant-32.png',
    },
  },
  // MV3 Firefox uses background.scripts (still ESM) — Chrome uses
  // background.service_worker. Branch on BROWSER so each side gets
  // the shape its runtime expects.
  background: browser === 'firefox'
    ? { scripts: ['src/background/index.ts'], type: 'module' }
    : { service_worker: 'src/background/index.ts', type: 'module' },
  permissions: [
    'storage',     // local + session storage for nsec, settings, sessionLogins,
                   // and the password-derived AES-GCM key cache
    'tabs',        // to read the active tab's URL/title for "save current page"
    'activeTab',   // user-gesture-scoped fallback
    'scripting',   // to scrape <title> / og:description for autofill
  ],
  host_permissions: [
    'https://*/*', // metadata-scrape content script can run on any https page when invoked
  ],
  content_scripts: [
    {
      // NIP-07 provider — runs in the page's MAIN world so it can
      // define `window.nostr` directly without inline-script injection.
      // Inline injection used to be the standard MV3 pattern but breaks
      // on strict-CSP pages (Gmail, Google Chat, GitHub, X) — script-src
      // without 'unsafe-inline' rejects element.textContent. MAIN-world
      // content scripts bypass page CSP entirely.
      // Requires Chrome 111+ / Firefox 128+.
      matches: ['https://*/*'],
      js: ['src/content-scripts/nip07-provider.ts'],
      run_at: 'document_start',
      world: 'MAIN',
      all_frames: false,
    },
    {
      // NIP-07 bridge — runs in the standard ISOLATED world so it has
      // access to chrome.runtime. Forwards window.postMessage from the
      // provider to the background service worker.
      matches: ['https://*/*'],
      js: ['src/content-scripts/nip07-bridge.ts'],
      run_at: 'document_start',
      all_frames: false,
    },
  ],
  web_accessible_resources: [
    {
      // pennant.svg is exposed to pages because the future NIP-07
      // approval prompt may want to render it inline. The actual
      // NIP-07 provider script will be added here when the injector
      // is built (see src/content-scripts/nip07-injector.ts).
      resources: ['pennant.svg'],
      matches: ['https://*/*'],
    },
  ],
  ...(browser === 'firefox'
    ? {
        browser_specific_settings: {
          gecko: {
            id: 'extension@deepmarks.org',
            // Bumped to 128 for content_scripts.world: 'MAIN' support
            // (Firefox 128, July 2024). Required for the NIP-07 provider
            // to define window.nostr without inline-script injection
            // that strict-CSP pages reject.
            strict_min_version: '128.0',
            // AMO requires this declaration per the new data-collection
            // policy (Firefox 128+). We don't collect anything — and
            // Mozilla's schema rejects an empty array; the explicit
            // "we collect nothing" answer is `['none']`, which is a
            // distinct enum value from leaving it unset.
            data_collection_permissions: { required: ['none'] as const },
          },
        },
      }
    : {}),
});
