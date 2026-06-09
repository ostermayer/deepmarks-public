// NDK pool — single shared instance for the whole app.
// NDK owns frontend relay state; nostr-tools handles low-level signing.
//
// We expose `getNdk()` for sync callers (already-connected pool) and
// `whenReady()` for callers that must wait for at least one relay to be
// online before publishing — prevents the silent "publish lost in the void"
// race during cold start.

import NDK, {
  NDKRelayStatus,
  type NDKCacheAdapter,
  type NDKRelay,
} from '@nostr-dev-kit/ndk';
import NDKCacheAdapterDexie from '@nostr-dev-kit/ndk-cache-dexie';
import { browser } from '$app/environment';
import { config } from '$lib/config.js';

let ndkInstance: NDK | null = null;
let connectPromise: Promise<void> | null = null;

const CONNECT_TIMEOUT_MS = 5000;

const CORE_RELAY_URLS = [config.deepmarksRelay, ...config.defaultRelays] as const;

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
    explicitRelayUrls: [...CORE_RELAY_URLS],
    // Disabled: server-side follows-ingester (Box A) handles outbox
    // reads — when a Deepmarks user follows someone, the worker
    // pulls that curator's content from their NIP-65 write relays
    // and mirrors into our strfry. The client doesn't need to open
    // WS connections to nos.lol / nostr.land / etc.; everything it
    // wants is on relay.deepmarks.org. Keeping outbox enabled here
    // was making the iOS app open WebSockets to every NIP-65 relay
    // in the user's contacts' lists, which both leaked the user's
    // IP to those relays and burned battery on flaky connections.
    enableOutboxModel: false,
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

function relayLookupKeys(url: string): string[] {
  const trimmed = url.replace(/\/$/, '');
  return [trimmed, `${trimmed}/`];
}

/** Keep the app's core relay set present and retry our own relay after
 *  transient disconnects. This cannot make an unavailable relay connect,
 *  but it prevents the pool from silently drifting away from
 *  relay.deepmarks.org on long-lived tabs. */
export function ensureCoreRelaysConnected(): void {
  ensureRelayUrlsConnected([...CORE_RELAY_URLS]);
}

export function ensureRelayUrlsConnected(urls: readonly string[]): void {
  const ndk = getNdk();
  for (const url of urls) {
    let relay: NDKRelay | undefined;
    for (const key of relayLookupKeys(url)) {
      relay = ndk.pool.relays.get(key);
      if (relay) break;
    }
    if (!relay) {
      relay = ndk.addExplicitRelay(url, undefined, true);
    }
    if (relay.status <= NDKRelayStatus.DISCONNECTED) {
      void relay.connect(CONNECT_TIMEOUT_MS, true).catch(() => {
        // The status panel will show red; NDK's reconnect loop handles retries.
      });
    }
  }
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
