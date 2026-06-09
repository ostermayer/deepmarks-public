/// <reference types="@sveltejs/kit" />
//
// Deepmarks service worker.
//
// Two jobs:
//   1. Offline app-shell — precache every chunk SvelteKit emits at
//      build time, plus the static files. When the network's gone
//      the SPA still loads from cache.
//   2. Web Push handler — receive push notifications (zaps on your
//      bookmarks, mentions, etc.) and show a system notification.
//      Subscription is set up from /app/settings; payment-proxy
//      sends the actual pushes via VAPID.
//
// Runtime cache:
//   - Cross-origin images are cached stale-while-revalidate. Nostr
//     profile pictures usually live on random media hosts whose cache
//     headers vary a lot, so keeping a bounded app-level image cache
//     prevents friend-feed avatars from reloading on every session.
//
// Out of scope:
//   - Background Sync for offline writes. NDK / signer / NIP-44
//     decryption all run on the main thread; the SW can't reach
//     them. The durable-publish queue (lib/nostr/pending-publish.ts)
//     already handles failed publishes in localStorage and replays
//     them on visibilitychange/foreground.
//   - API response caching. /bookmarks/public, /profile/:pubkey, etc.
//     are already mirrored into the in-app localStorage stores
//     (ownBookmarks, profileCache) for offline reads; layering an SW
//     cache on top creates a second source of truth that's hard to
//     invalidate when a save happens.

import { build, files, version, prerendered } from '$service-worker';

const CACHE = `deepmarks-${version}`;
const IMAGE_CACHE = 'deepmarks-profile-images-v1';
const IMAGE_CACHE_MAX_ENTRIES = 500;

/** Everything we want available offline: app shell + static files +
 *  any prerendered SSR'd pages. SvelteKit's $service-worker module
 *  hands us these as part of the build. */
const PRECACHE: readonly string[] = [
  ...build,
  ...files,
  ...prerendered,
];

const sw = self as unknown as ServiceWorkerGlobalScope;

sw.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(PRECACHE);
      // Activate the new SW as soon as it's installed instead of
      // waiting for every tab to close — this matters because the
      // app is long-lived (signed-in users keep tabs open for days).
      await sw.skipWaiting();
    })(),
  );
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop caches from older builds. Each build's PRECACHE is
      // versioned (CACHE = `deepmarks-${version}`); old caches are
      // dead weight.
      const keys = await caches.keys();
      const keep = new Set([CACHE, IMAGE_CACHE]);
      await Promise.all(
        keys
          .filter((k) => k.startsWith('deepmarks-') && !keep.has(k))
          .map((k) => caches.delete(k)),
      );
      await sw.clients.claim();
    })(),
  );
});

sw.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (shouldCacheRuntimeImage(request, url)) {
    event.respondWith(staleWhileRevalidateImage(event));
    return;
  }
  // Only intercept same-origin requests. Cross-origin (api.deepmarks.org,
  // blossom, relay WSS, etc.) is left to the browser
  // and the in-app caches, except for profile/media images above.
  if (url.origin !== sw.location.origin) return;
  // Skip the WS upgrade attempt SvelteKit's HMR pings during dev.
  if (url.pathname.startsWith('/_app/version.json')) return;
  // Precached asset: serve from cache, fall back to network if
  // missing (handles new chunks the precache list doesn't know about
  // yet — though SvelteKit's manifest is exhaustive).
  if (PRECACHE.includes(url.pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }
  // Navigation request (the user is loading a route): network-first
  // with cache fallback. Lets the user reach the app even when
  // offline; when online they get the freshest HTML.
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }
  // Anything else same-origin (e.g. /favicon.svg, /pennant.svg,
  // _app/immutable assets not in the precache list): stale-while-
  // revalidate.
  event.respondWith(staleWhileRevalidate(request));
});

async function cacheFirst(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const fresh = await fetch(request);
  if (fresh.ok) await cache.put(request, fresh.clone());
  return fresh;
}

async function networkFirst(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetch(request);
    if (fresh.ok) await cache.put(request, fresh.clone());
    return fresh;
  } catch (err) {
    const hit = await cache.match(request);
    if (hit) return hit;
    // For navigation requests with no cached HTML, fall back to
    // index.html — the SPA can route client-side once it boots.
    const fallback = await cache.match('/');
    if (fallback) return fallback;
    throw err;
  }
}

async function staleWhileRevalidate(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  const fetchPromise = fetch(request).then((response) => {
    if (response.ok) cache.put(request, response.clone()).catch(() => undefined);
    return response;
  }).catch(() => undefined);
  return hit ?? (await fetchPromise) ?? new Response('Offline', { status: 503 });
}

function shouldCacheRuntimeImage(request: Request, url: URL): boolean {
  return (
    request.destination === 'image'
    && url.origin !== sw.location.origin
    && (url.protocol === 'https:' || url.protocol === 'http:')
  );
}

async function staleWhileRevalidateImage(event: FetchEvent): Promise<Response> {
  const { request } = event;
  const cache = await caches.open(IMAGE_CACHE);
  const hit = await cache.match(request, { ignoreVary: true });
  const fetchPromise = fetch(request)
    .then((response) => {
      if (isCacheableImageResponse(response)) {
        const write = cache.put(request, response.clone())
          .then(() => trimCache(cache, IMAGE_CACHE_MAX_ENTRIES))
          .catch(() => undefined);
        event.waitUntil(write);
      }
      return response;
    })
    .catch(() => undefined);
  event.waitUntil(fetchPromise.then(() => undefined));
  return hit
    ?? (await fetchPromise)
    ?? new Response('', { status: 504, statusText: 'Image unavailable' });
}

function isCacheableImageResponse(response: Response): boolean {
  return response.ok || response.type === 'opaque';
}

async function trimCache(cache: Cache, maxEntries: number): Promise<void> {
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  await Promise.all(keys.slice(0, keys.length - maxEntries).map((key) => cache.delete(key)));
}

// ── Web Push ────────────────────────────────────────────────────────

interface PushPayload {
  title?: string;
  body?: string;
  url?: string;
  icon?: string;
  tag?: string;
}

sw.addEventListener('push', (event) => {
  let payload: PushPayload = {};
  try {
    payload = (event.data?.json() as PushPayload) ?? {};
  } catch {
    // Some VAPID setups send a plain string. Treat it as the body.
    payload = { body: event.data?.text() ?? '' };
  }
  const title = payload.title?.trim() || 'Deepmarks';
  const options: NotificationOptions = {
    body: payload.body ?? '',
    icon: payload.icon ?? '/pennant.svg',
    badge: '/pennant.svg',
    tag: payload.tag,
    data: { url: payload.url ?? '/app/bookmarks' },
  };
  event.waitUntil(sw.registration.showNotification(title, options));
});

sw.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data as { url?: string } | null)?.url ?? '/app/bookmarks';
  event.waitUntil(
    (async () => {
      const allWindows = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // If a Deepmarks tab is already open, focus it and route there
      // instead of opening a duplicate.
      for (const client of allWindows) {
        if (new URL(client.url).origin === sw.location.origin) {
          await client.focus();
          if ('navigate' in client) await (client as WindowClient).navigate(target);
          return;
        }
      }
      await sw.clients.openWindow(target);
    })(),
  );
});
