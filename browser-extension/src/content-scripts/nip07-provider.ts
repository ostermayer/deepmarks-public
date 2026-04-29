// NIP-07 page-world provider.
//
// Runs in the page's MAIN world via manifest.content_scripts.world,
// so we can define `window.nostr` directly without injecting an
// inline <script>. Inline injection used to be the standard MV3
// pattern, but strict-CSP pages (Gmail, Google Chat, GitHub, X)
// reject it — script-src without 'unsafe-inline' blocks the
// element.textContent assignment with no escape hatch.
//
// Talks to the bridge content script (which lives in the ISOLATED
// world and has chrome.runtime access) via window.postMessage. The
// bridge then forwards to the background service worker.
//
// Each call from the page (getPublicKey, signEvent, getRelays,
// nip04.encrypt/decrypt, nip44.encrypt/decrypt) hops:
//   page → window.postMessage → bridge content script →
//   chrome.runtime.sendMessage → background service worker → nsec
//   store + (sometimes) user prompt → reply back along the chain.

(function setupProvider(): void {
  'use strict';

  type CallReply = { id: string; source: string; result?: unknown; error?: string };
  interface PendingEntry {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
  }

  const REQUEST_TIMEOUT_MS = 60 * 1000;
  // Pin postMessage to our own origin so a navigation-mid-call can't
  // leak nip04/nip44 plaintext into a foreign document. Captured
  // once at injector load (origin doesn't change for a document's life).
  const ownOrigin = window.location.origin;
  let requestId = 0;
  const pending = new Map<string, PendingEntry>();

  function call(method: string, params: unknown[]): Promise<unknown> {
    const id =
      'dm-nip07-' +
      ++requestId +
      '-' +
      Math.random().toString(36).slice(2, 8);
    return new Promise<unknown>((resolve, reject) => {
      // Hard timeout: if the service worker is killed mid-call, the
      // page-side promise would otherwise hang forever and pin its
      // resolver / params closure in memory.
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error('deepmarks: request timed out'));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject:  (e) => { clearTimeout(timer); reject(e); },
      });
      window.postMessage(
        { source: 'deepmarks-nip07', id, method, params },
        ownOrigin,
      );
    });
  }

  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window) return;
    if (e.origin !== ownOrigin) return;
    const data = e.data as CallReply | null;
    if (!data || data.source !== 'deepmarks-nip07-response' || !data.id) return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.error) entry.reject(new Error(data.error));
    else entry.resolve(data.result);
  });

  // Don't clobber an existing provider — another extension (Alby,
  // nos2x) may have arrived first. NIP-07 says first-injector wins.
  const w = window as unknown as { nostr?: unknown };
  if (!w.nostr) {
    w.nostr = {
      getPublicKey: (): Promise<unknown> => call('getPublicKey', []),
      signEvent: (event: unknown): Promise<unknown> => call('signEvent', [event]),
      getRelays: (): Promise<unknown> => call('getRelays', []),
      nip04: {
        encrypt: (pubkey: string, plaintext: string): Promise<unknown> =>
          call('nip04.encrypt', [pubkey, plaintext]),
        decrypt: (pubkey: string, ciphertext: string): Promise<unknown> =>
          call('nip04.decrypt', [pubkey, ciphertext]),
      },
      nip44: {
        encrypt: (pubkey: string, plaintext: string): Promise<unknown> =>
          call('nip44.encrypt', [pubkey, plaintext]),
        decrypt: (pubkey: string, ciphertext: string): Promise<unknown> =>
          call('nip44.decrypt', [pubkey, ciphertext]),
      },
    };
  }
})();

// MAIN-world content scripts must be a module-shaped file or contain
// at least one export to make TypeScript treat it as a module — empty
// export keeps it scoped without leaking globals.
export {};
