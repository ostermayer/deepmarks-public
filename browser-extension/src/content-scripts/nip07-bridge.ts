// NIP-07 + WebLN isolated-world bridge.
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
// WebLN uses the same path for window.webln.enable/getInfo/sendPayment.
//
// Why two scripts instead of one? Pre-Chrome-111 / pre-Firefox-128
// the standard pattern was: single ISOLATED-world content script
// that injects an inline <script> defining window.nostr. That fails
// hard on strict-CSP pages (Gmail, Google Chat, GitHub, X) because
// script-src without 'unsafe-inline' rejects the inline element.
// MAIN-world content scripts bypass page CSP and don't need the
// inline trick.
//
// Safari MAIN-world fallback: as of Safari 18, manifest content_scripts
// with `world: "MAIN"` don't reliably inject on every page (the
// provider silently fails to execute, leaving window.nostr undefined
// even though the bridge below is alive). We belt-and-suspenders by
// also injecting the provider here as a <script src> tag pointing at
// the web_accessible_resource. Browsers grant extension-origin scripts
// a CSP bypass for their own origin, so this works on strict-CSP pages
// too. The provider's `if (!w.nostr)` guard makes double-injection a
// no-op on Chrome/Firefox where MAIN-world already ran.
(function injectProvider(): void {
  try {
    const runtime = typeof chrome === 'undefined' ? undefined : chrome.runtime;
    if (!runtime?.getURL) return;
    const src = runtime.getURL('assets/nip07-provider.ts.js');
    const script = document.createElement('script');
    script.src = src;
    // Provider is a self-contained IIFE — loading as a classic script
    // avoids the stricter CORS handling Safari applies to module
    // scripts at extension origin.
    // Append to documentElement (not head) — at document_start the
    // <head> may not exist yet on some pages.
    const parent = document.head || document.documentElement;
    if (!parent) return;
    script.addEventListener('load', () => script.remove());
    script.addEventListener('error', () => script.remove());
    parent.appendChild(script);
  } catch {
    // CSP block or DOM not ready — MAIN-world content script is the
    // only path on this page, and we can't fix it from here.
  }
})();

const OWN_ORIGIN = window.location.origin;

// Page-world methods we know how to handle. Anything else we reject at the
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
  'webln.enable',
  'webln.getInfo',
  'webln.sendPayment',
  'deepmarks.ping',
  'deepmarks.nwc.get',
  'deepmarks.nwc.connect',
  'deepmarks.nwc.clear',
  'deepmarks.archive.reconcile',
]);

function postReply(
  id: string | undefined,
  reply: { result?: unknown; error?: string },
): void {
  window.postMessage(
    {
      source: 'deepmarks-nip07-response',
      id,
      result: reply.result,
      error: reply.error,
    },
    OWN_ORIGIN,
  );
}

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window) return;
  if (e.origin !== OWN_ORIGIN) return;
  const data = e.data as
    | { source: string; id: string; method: string; params: unknown[] }
    | null;
  if (!data || data.source !== 'deepmarks-nip07') return;

  if (typeof data.method !== 'string' || !ALLOWED_METHODS.has(data.method)) {
    postReply(data.id, {
      error: `unsupported NIP-07 method: ${typeof data.method === 'string' ? data.method : '(invalid)'}`,
    });
    return;
  }

  try {
    const runtime = typeof chrome === 'undefined' ? undefined : chrome.runtime;
    if (!runtime?.id || !runtime.sendMessage) {
      throw new Error('extension runtime unavailable — reload this tab');
    }
    void runtime
      .sendMessage({
        kind: 'nip07',
        id: data.id,
        method: data.method,
        params: data.params,
        origin: OWN_ORIGIN,
        title: document.title,
      })
      .then((reply: { result?: unknown; error?: string }) => {
        postReply(data.id, {
          result: reply?.result,
          error: reply?.error,
        });
      })
      .catch((err) => {
        postReply(data.id, {
          error: (err as Error).message ?? 'extension unreachable',
        });
      });
  } catch (err) {
    postReply(data.id, {
      error: (err as Error).message ?? 'extension unreachable — reload this tab',
    });
  }
});

export {};
