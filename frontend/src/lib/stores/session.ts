// Session store — holds the active ResolvedSigner + cached pubkey/email.
//
// Persistence policy:
//   - hint (kind + npub): localStorage. Never secret.
//   - nsec hex (when kind === 'nsec'): localStorage. Persists until the user
//     explicitly hits "sign out" — closing the tab or restarting the browser
//     does NOT log them out. This is a deliberate relaxation of the original
//     "memory-only / sessionStorage-only" rules so the app behaves like
//     every other site they're used to: you sign in, you stay signed in.
//     The nsec still never touches our server.
//   - signer instance: never persisted; re-derived from the nsec on rehydrate.
//
// Migration note: an earlier build wrote the nsec to sessionStorage. The
// readNsec() helper falls back to that on first load so existing users
// don't lose their session, then re-writes to localStorage going forward.

import { writable, derived, get } from 'svelte/store';
// `get` is also used inside rehydrate() to peek at the live store state
// without subscribing — see the race-protection note there.
import { browser } from '$app/environment';
import { nip19 } from 'nostr-tools';
import type { ResolvedSigner, SignerKind } from '$lib/nostr/signers';
import { createNip07Signer, isNip07Available } from '$lib/nostr/signers/nip07';
import { createNsecSigner } from '$lib/nostr/signers/nsec';
import { getNdk } from '$lib/nostr/ndk';

const HINT_KEY = 'deepmarks-session-hint';
const NSEC_KEY = 'deepmarks-session-nsec';

export interface SessionHint {
  kind: SignerKind;
  npub: string;
}

interface SessionState {
  signer: ResolvedSigner | null;
  pubkey: string | null;
}

function readHint(): SessionHint | null {
  if (!browser) return null;
  try {
    const raw = localStorage.getItem(HINT_KEY);
    return raw ? (JSON.parse(raw) as SessionHint) : null;
  } catch {
    return null;
  }
}

function writeHint(hint: SessionHint | null) {
  if (!browser) return;
  if (hint) localStorage.setItem(HINT_KEY, JSON.stringify(hint));
  else localStorage.removeItem(HINT_KEY);
}

function readNsec(): string | null {
  if (!browser) return null;
  try {
    const fromLocal = localStorage.getItem(NSEC_KEY);
    if (fromLocal) return fromLocal;
    // Migration: pull old sessionStorage value forward and re-stash in
    // localStorage so the next reload finds it there.
    const fromSession = sessionStorage.getItem(NSEC_KEY);
    if (fromSession) {
      try { localStorage.setItem(NSEC_KEY, fromSession); } catch { /* quota */ }
      try { sessionStorage.removeItem(NSEC_KEY); } catch { /* private */ }
      return fromSession;
    }
    return null;
  } catch {
    return null;
  }
}

function writeNsec(nsecHex: string | null) {
  if (!browser) return;
  try {
    if (nsecHex) localStorage.setItem(NSEC_KEY, nsecHex);
    else localStorage.removeItem(NSEC_KEY);
  } catch {
    // Private-mode Safari throws on localStorage writes. Fall through —
    // we still have the signer in memory for this tab.
  }
  // Also clear any sessionStorage leftover from the migration window.
  try { sessionStorage.removeItem(NSEC_KEY); } catch { /* private */ }
}

/** Eagerly seed the store at module-evaluation time so `$session.pubkey`
 *  is non-null on the very first render — every cache prime that gates
 *  on a known pubkey (feed, profile, archives, private bookmarks) can
 *  fire synchronously from localStorage. The signer still attaches
 *  asynchronously inside rehydrate(); only the pubkey is published
 *  early. SSR / non-browser contexts skip the read and start at null.
 *
 *  Without this seed, every refresh of /app showed an empty 'listening
 *  to relays…' state for the duration of the signer handshake
 *  (NDKNip07Signer.blockUntilReady is an async RPC into the extension). */
function initialPubkeyFromHint(): string | null {
  if (!browser) return null;
  const hint = readHint();
  if (!hint) return null;
  try {
    const decoded = nip19.decode(hint.npub);
    if (decoded.type !== 'npub') return null;
    return decoded.data as string;
  } catch {
    return null;
  }
}
const internal = writable<SessionState>({ signer: null, pubkey: initialPubkeyFromHint() });

export const session = {
  subscribe: internal.subscribe,
  // Getter — re-reads localStorage on every access. Was a snapshot at
  // module init, which broke navigation back to "/" after sign-in: the
  // homepage checked session.hint, saw the stale null, didn't redirect,
  // and dumped the user on the marketing page as if logged out.
  get hint(): SessionHint | null {
    return readHint();
  },
  async login(signer: ResolvedSigner) {
    const npub = nip19.npubEncode(signer.pubkey);
    writeHint({ kind: signer.kind, npub });
    // Stash the nsec in sessionStorage so refresh doesn't drop the signer.
    // createNsecSigner hands us the hex on the signer object; other kinds
    // (nip07 / nip46) don't expose a raw key so nothing to store.
    if (signer.kind === 'nsec' && signer.nsecHex) writeNsec(signer.nsecHex);
    // Attach to the shared NDK pool so publishes are signed automatically.
    getNdk().signer = signer.ndk;
    internal.set({ signer, pubkey: signer.pubkey });
  },
  logout() {
    writeHint(null);
    writeNsec(null);
    const ndk = getNdk();
    ndk.signer = undefined;
    internal.set({ signer: null, pubkey: null });
  },
  /**
   * Restore session on page load from the persisted hint.
   *
   * - NIP-07: silently re-authorize via the extension.
   * - Nsec: read the hex from sessionStorage (tab-scoped) and rebuild the
   *   signer. If sessionStorage was cleared (tab closed + reopened), fall
   *   through to pubkey-only — UI will prompt for nsec.
   * - NIP-46: pubkey only; user reconnects the bunker on next action.
   */
  async rehydrate() {
    if (!browser) return;
    const hint = readHint();
    if (!hint) return;
    // Race protection: rehydrate() is fired from +layout onMount without
    // an await. If the user lands on /login and triggers a sign-in flow
    // before rehydrate finishes (NIP-07 prompt, passkey OS picker, etc.),
    // session.login may have already attached a signer. We must NOT
    // clobber that with a `internal.set({ signer: null, pubkey })` at
    // the end of this function — bail at every store-write point if a
    // signer has appeared while we were async-waiting.
    const hasSignerNow = () => get(internal).signer !== null;
    try {
      const decoded = nip19.decode(hint.npub);
      if (decoded.type !== 'npub') return;
      const pubkey = decoded.data as string;

      // Synchronous pubkey publish so every cache-prime that gates on
      // $session.pubkey (feed, my-archives, profile, private set) can
      // fire on the first paint. The signer attaches asynchronously
      // below; canSign-gated paths still wait for that, but the
      // pubkey-only paths don't have to. Without this every refresh
      // shows an empty 'loading…' state for the duration of the
      // signer handshake (NDKNip07Signer.blockUntilReady does an
      // extension RPC; sometimes 100s of ms).
      if (!hasSignerNow() && get(internal).pubkey !== pubkey) {
        internal.set({ signer: null, pubkey });
      }

      if (hint.kind === 'nip07' && isNip07Available()) {
        const signer = await createNip07Signer();
        if (hasSignerNow()) return;
        getNdk().signer = signer.ndk;
        internal.set({ signer, pubkey: signer.pubkey });
      } else if (hint.kind === 'nsec') {
        const nsecHex = readNsec();
        if (nsecHex) {
          try {
            const signer = await createNsecSigner(nsecHex);
            if (hasSignerNow()) return;
            if (signer.pubkey !== pubkey) {
              // sessionStorage nsec doesn't match the hint pubkey — stale
              // state. Drop both and force re-sign-in.
              writeNsec(null);
              writeHint(null);
              return;
            }
            getNdk().signer = signer.ndk;
            internal.set({ signer, pubkey: signer.pubkey });
            return;
          } catch {
            writeNsec(null);
          }
        }
        if (hasSignerNow()) return;
        internal.set({ signer: null, pubkey });
      } else {
        // bunker | future kinds: pubkey only, UI reconnects.
        if (hasSignerNow()) return;
        internal.set({ signer: null, pubkey });
      }
    } catch {
      // Bad hint — drop it (and any paired nsec) so next visit is clean.
      writeHint(null);
      writeNsec(null);
    }
  }
};

export const npub = derived(internal, ($s) =>
  $s.pubkey ? nip19.npubEncode($s.pubkey) : null
);
export const isAuthenticated = derived(internal, ($s) => !!$s.pubkey);
export const canSign = derived(internal, ($s) => !!$s.signer);

export function currentSession(): SessionState {
  return get(internal);
}
