// NIP-07 isolated-world bridge.
//
// Pairs with nip07-provider.ts (which runs in the page's MAIN world
// and defines `window.nostr`). This bridge runs in the standard
// content-script ISOLATED world so it has access to chrome.runtime —
// the page does not.
//
// Flow:
//   page calls window.nostr.signEvent(...) → provider posts a
//   message to window → this bridge receives it → forwards to the
//   background service worker → posts the reply back to the page.
//
// Why two scripts instead of one? Pre-Chrome-111 / pre-Firefox-128
// the standard pattern was: single ISOLATED-world content script
// that injects an inline <script> defining window.nostr. That fails
// hard on strict-CSP pages (Gmail, Google Chat, GitHub, X) because
// script-src without 'unsafe-inline' rejects the inline element.
// MAIN-world content scripts bypass page CSP and don't need the
// inline trick.

const OWN_ORIGIN = window.location.origin;

// NIP-07 methods we know how to handle. Anything else we reject at the
// bridge instead of forwarding to the background — the background's
// SignRequest UI prints `req.method` verbatim, so an unknown method
// like `"This is your bank — please approve"` would otherwise be
// presented to the user as the action label and create a UI-spoof
// surface. Keep this list in sync with the switch in
// background/index.ts:executeApprovedRequest.
const ALLOWED_METHODS = new Set([
  'getPublicKey',
  'getRelays',
  'signEvent',
  'nip04.encrypt',
  'nip04.decrypt',
  'nip44.encrypt',
  'nip44.decrypt',
]);

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window) return;
  if (e.origin !== OWN_ORIGIN) return;
  const data = e.data as
    | { source: string; id: string; method: string; params: unknown[] }
    | null;
  if (!data || data.source !== 'deepmarks-nip07') return;

  if (typeof data.method !== 'string' || !ALLOWED_METHODS.has(data.method)) {
    window.postMessage(
      {
        source: 'deepmarks-nip07-response',
        id: data.id,
        error: `unsupported NIP-07 method: ${typeof data.method === 'string' ? data.method : '(invalid)'}`,
      },
      OWN_ORIGIN,
    );
    return;
  }

  void chrome.runtime
    .sendMessage({
      kind: 'nip07',
      id: data.id,
      method: data.method,
      params: data.params,
      origin: OWN_ORIGIN,
      title: document.title,
    })
    .then((reply: { result?: unknown; error?: string }) => {
      window.postMessage(
        {
          source: 'deepmarks-nip07-response',
          id: data.id,
          result: reply?.result,
          error: reply?.error,
        },
        OWN_ORIGIN,
      );
    })
    .catch((err) => {
      window.postMessage(
        {
          source: 'deepmarks-nip07-response',
          id: data.id,
          error: (err as Error).message ?? 'extension unreachable',
        },
        OWN_ORIGIN,
      );
    });
});

export {};
