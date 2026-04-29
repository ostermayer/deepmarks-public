// NDK pool — single shared instance for the whole app.
// CLAUDE.md: NDK on the frontend, nostr-tools for low-level signing.
//
// We expose `getNdk()` for sync callers (already-connected pool) and
// `whenReady()` for callers that must wait for at least one relay to be
// online before publishing — prevents the silent "publish lost in the void"
// race during cold start.

import NDK, { NDKEvent, NDKRelay, NDKRelaySet, type NDKCacheAdapter } from '@nostr-dev-kit/ndk';
import NDKCacheAdapterDexie from '@nostr-dev-kit/ndk-cache-dexie';
import { browser } from '$app/environment';
import { config } from '$lib/config.js';

let ndkInstance: NDK | null = null;
let connectPromise: Promise<void> | null = null;

const CONNECT_TIMEOUT_MS = 5000;

function instantiate(): NDK {
  // IndexedDB-backed event cache. Persists every event NDK has seen
  // across page reloads + sessions, so:
  //   - Reload paints from cache instantly; live subscription
  //     refreshes underneath.
  //   - Replaceable events (kind:0 profiles, kind:30003 sets,
  //     kind:10002 relay lists, kind:10000 mute lists, kind:3
  //     contacts) are kept fresh by NDK's internal eviction.
  //   - Profile lookups don't need our hand-rolled localStorage
  //     cache — they're a normal NDK query that hits the cache first.
  // Server-side rendering / tests skip the cache (no IndexedDB).
  // The published cache-dexie pkg ships its own (slightly older)
  // @nostr-dev-kit/ndk types, so the adapter's NDKEvent / NDKFilter
  // types diverge from our NDK's by one new event kind. The runtime
  // ABI is fully compatible — they're both the same NDKCacheAdapter
  // shape — so cast through `unknown` to NDKCacheAdapter.
  const cacheAdapter: NDKCacheAdapter | undefined = browser
    ? (new NDKCacheAdapterDexie({
        dbName: 'deepmarks-ndk-cache',
        eventCacheSize: 10_000,
        profileCacheSize: 2_000,
      }) as unknown as NDKCacheAdapter)
    : undefined;

  const ndk = new NDK({
    explicitRelayUrls: [config.deepmarksRelay, ...config.defaultRelays],
    enableOutboxModel: true,
    cacheAdapter,
    // Verify every event from every relay. NDK's default ramps validation
    // down to 10% per trusted relay, which lets a permissive or compromised
    // relay slip pubkey-spoofed events through. With the nsec now in
    // localStorage, an XSS-grade impersonation here would be catastrophic.
    initialValidationRatio: 1,
    lowestValidationRatio: 1,
  });
  connectPromise = ndk.connect(CONNECT_TIMEOUT_MS).catch((e: unknown) => {
    // Connect can reject if zero relays come online inside the timeout.
    // Keep the rejection observable so whenReady() callers know to retry,
    // but don't crash other code paths.
    console.warn('NDK initial connect failed:', e);
    throw e;
  });
  return ndk;
}

export function getNdk(): NDK {
  if (!ndkInstance) ndkInstance = instantiate();
  return ndkInstance;
}

/** Resolves once the initial connect handshake settles. Re-throws connect errors. */
export async function whenReady(): Promise<void> {
  getNdk();
  if (connectPromise) await connectPromise;
}

/** Test-only: drop the singleton so each test gets a fresh NDK. */
export function __resetNdkForTests(): void {
  ndkInstance = null;
  connectPromise = null;
}

export { NDKEvent, NDKRelay, NDKRelaySet };
