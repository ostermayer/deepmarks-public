// Capacitor deep-link handler — routes `deepmarks://…` URLs from the
// iOS Share Extension and Android SEND intent into the SvelteKit
// router.
//
// Wire-up: called once from the root layout's onMount. On web this
// is a no-op (Capacitor's App plugin only fires inside a native
// shell), so safe to import unconditionally.
//
// Supported URLs:
//   deepmarks://save?url=<encoded URL>
//      → goto('/app/save?url=<encoded URL>')
//   nostrconnect://<client-pubkey>?relay=…&secret=…
//      → goto('/app/mobile-signer?connect=<encoded original URL>')
//   deepmarks://signer?connect=<encoded nostrconnect URL>
//      → goto('/app/mobile-signer?connect=<encoded nostrconnect URL>')
//   bunker://<remote-signer-pubkey>?relay=…&secret=…
//      → goto('/login?bunker=<encoded original URL>')
//   deepmarks://upgrade?done=1
//      → goto('/app/upgrade?done=1')
//
// More schemes can join the dispatch table as the native side
// learns them (e.g. deepmarks://profile?npub=… for share-receiving
// from another Nostr client).

import { goto } from '$app/navigation';
import { browser } from '$app/environment';

interface AppUrlOpenEvent {
  url: string;
}

function routeMobileSigner(rawUrl: string): boolean {
  void goto(`/app/mobile-signer?connect=${encodeURIComponent(rawUrl)}`);
  return true;
}

function routeBunkerLogin(rawUrl: string): boolean {
  void goto(`/login?bunker=${encodeURIComponent(rawUrl)}`);
  return true;
}

/** Strip the scheme + slashes so we can route `host?query`. Treats
 *  `deepmarks:save?url=…` (no `//`), `deepmarks://save?url=…`, and
 *  `https://deepmarks.org/app/save?url=…` (universal-link variant)
 *  uniformly. */
function parseAppUrl(raw: string): { path: string; query: URLSearchParams } | null {
  try {
    const u = new URL(raw);
    if (u.protocol === 'nostrconnect:') {
      return { path: 'mobile-signer-external', query: new URLSearchParams([['url', raw]]) };
    }
    if (u.protocol === 'bunker:') {
      return { path: 'bunker-login-external', query: new URLSearchParams([['url', raw]]) };
    }
    if (u.protocol === 'nostrsigner:') {
      return { path: 'android-signer-external', query: new URLSearchParams([['url', raw]]) };
    }
    if (u.protocol === 'deepmarks:') {
      // url shape: deepmarks://save?url=…  → host = 'save', search = '?url=…'
      // OR        deepmarks:save?url=…     → host = '', pathname = 'save'
      const path = u.host || u.pathname.replace(/^\/+/, '');
      return { path, query: u.searchParams };
    }
    // Universal-link variant: https://deepmarks.org/app/save?url=…
    // Strip any leading /app/ so the dispatch table can match the
    // same way regardless of how the URL was opened.
    const stripped = u.pathname.replace(/^\/+/, '').replace(/^app\//, '');
    return { path: stripped, query: u.searchParams };
  } catch {
    return null;
  }
}

/** Dispatch a parsed app URL to a SvelteKit route. Returns true when
 *  routed; false when the URL didn't match any known shape. */
function dispatch(parsed: { path: string; query: URLSearchParams }): boolean {
  switch (parsed.path) {
    case 'mobile-signer-external': {
      const url = parsed.query.get('url') ?? '';
      return url ? routeMobileSigner(url) : false;
    }
    case 'bunker-login-external': {
      const url = parsed.query.get('url') ?? '';
      return url ? routeBunkerLogin(url) : false;
    }
    case 'android-signer-external': {
      void goto('/app/mobile-signer/android');
      return true;
    }
    case 'login': {
      const query = parsed.query.toString();
      const target = query ? `/login?${query}` : '/login';
      void goto(target);
      return true;
    }
    case 'signer':
    case 'mobile-signer': {
      const androidRequest = parsed.query.get('androidRequest') || parsed.query.get('request') || '';
      if (androidRequest) {
        void goto(`/app/mobile-signer/android?request=${encodeURIComponent(androidRequest)}`);
        return true;
      }
      const connect = parsed.query.get('connect') || parsed.query.get('uri') || parsed.query.get('url') || '';
      if (connect.startsWith('bunker:')) return routeBunkerLogin(connect);
      const target = connect
        ? `/app/mobile-signer?connect=${encodeURIComponent(connect)}`
        : '/app/mobile-signer';
      void goto(target);
      return true;
    }
    case 'save': {
      // Pending-share-id case: silent background drain. Avoids pulling
      // the user off whatever tab they're on (pull-to-refresh used to
      // re-fire this navigation, which felt like a bug).
      if (parsed.query.get('pendingShareId')) {
        void triggerSilentDrain();
        return true;
      }
      // Plain url case (web direct link, Android SEND): show the save
      // form prefilled.
      const query = parsed.query.toString();
      const target = query ? `/app/save?${query}` : '/app/save';
      void goto(target);
      return true;
    }
    case 'upgrade': {
      const query = parsed.query.toString();
      const target = query ? `/app/upgrade?${query}` : '/app/upgrade';
      void goto(target);
      return true;
    }
    case 'bookmarks': {
      const query = parsed.query.toString();
      const target = query ? `/app/bookmarks?${query}` : '/app/bookmarks';
      void goto(target);
      return true;
    }
    default:
      return false;
  }
}

async function triggerSilentDrain(): Promise<void> {
  try {
    const { drainPendingShares } = await import('$lib/mobile/share-drain');
    await drainPendingShares();
  } catch {
    // The drain logs/records its own failures; nothing to surface here.
  }
}

/** Register the listener. Returns a cleanup function the caller can
 *  use from onMount's return value. */
export async function setupDeepLinks(): Promise<() => void> {
  if (!browser) return () => {};
  // Dynamic import so a web-only build doesn't pull the native
  // plugin in. Capacitor's App plugin re-exports a stub on web that
  // resolves to no-op — safe to call either way, just unnecessary
  // weight when not in a native shell.
  let mod: typeof import('@capacitor/app');
  try {
    mod = await import('@capacitor/app');
  } catch {
    // Plugin not installed in this build (shouldn't happen — we list
    // it as a dep), but fail soft anyway.
    return () => {};
  }

  let lastHandledUrl = '';
  let lastHandledAt = 0;
  const handleUrl = (url: string): boolean => {
    const now = Date.now();
    if (url === lastHandledUrl && now - lastHandledAt < 1000) return false;
    lastHandledUrl = url;
    lastHandledAt = now;
    const parsed = parseAppUrl(url);
    return parsed ? dispatch(parsed) : false;
  };
  let routedLaunchUrl = false;

  try {
    const launch = await mod.App.getLaunchUrl();
    if (launch?.url) routedLaunchUrl = handleUrl(launch.url);
  } catch {
    // Some Capacitor hosts expose the App listener but not the launch
    // URL helper. The live appUrlOpen listener below still handles
    // warm opens.
  }

  let handle: Awaited<ReturnType<typeof mod.App.addListener>>;
  try {
    handle = await mod.App.addListener('appUrlOpen', (event: AppUrlOpenEvent) => {
      handleUrl(event.url);
    });
  } catch {
    return () => {};
  }
  // Whether or not a launch URL was routed, fire one drain so any
  // pending share left in AppGroup (e.g. Safari denied the host-app
  // open prompt, or the user dismissed it) gets saved silently.
  void triggerSilentDrain();
  return () => { void handle.remove(); };
}
