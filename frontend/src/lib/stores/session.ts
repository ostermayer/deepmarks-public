// Session store — holds the active ResolvedSigner + cached pubkey/email.
//
// Persistence policy:
//   - hint (kind + npub): localStorage. Never secret.
//   - nsec hex: persisted in localStorage only when the caller opts in.
//     This keeps recovery-key/passkey sessions usable across refresh/back
//     and browser restarts, while logout wipes it. Browser extension and
//     remote-signer sessions never store an nsec here.
//   - NIP-46 payload: persisted for remote-signer sessions. This is the
//     client's pairing key, not the user's nsec; logout wipes it.
//   - signer instance: never persisted; re-derived from stored state on rehydrate.

import { writable, derived, get } from 'svelte/store';
// `get` is also used inside rehydrate() to peek at the live store state
// without subscribing — see the race-protection note there.
import { browser } from '$app/environment';
import { nip19 } from 'nostr-tools';
import type { ResolvedSigner, SignerKind } from '$lib/nostr/signers';

const HINT_KEY = 'deepmarks-session-hint';
const NSEC_KEY = 'deepmarks-session-nsec';
const NIP46_KEY = 'deepmarks-session-nip46';
const ANDROID_SIGNER_KEY = 'deepmarks-session-android-signer';

export interface SessionHint {
  kind: SignerKind;
  npub: string;
}

interface SessionState {
  signer: ResolvedSigner | null;
  pubkey: string | null;
}

interface LoginOptions {
  /** When true, store the raw nsec in this browser for automatic restore. */
  persistNsec?: boolean;
  /** Deprecated alias from a short-lived sessionStorage-only build. */
  cacheNsecInTab?: boolean;
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

function clearStoredNsec() {
  if (!browser) return;
  try { localStorage.removeItem(NSEC_KEY); } catch { /* private */ }
  try { sessionStorage.removeItem(NSEC_KEY); } catch { /* private */ }
}

function clearStoredNip46Payload() {
  if (!browser) return;
  try { localStorage.removeItem(NIP46_KEY); } catch { /* private */ }
}

function clearStoredAndroidSignerPayload() {
  if (!browser) return;
  try { localStorage.removeItem(ANDROID_SIGNER_KEY); } catch { /* private */ }
}

function readStoredNsec(): string | null {
  if (!browser) return null;
  try {
    const local = localStorage.getItem(NSEC_KEY);
    if (local) return local;
    return sessionStorage.getItem(NSEC_KEY);
  } catch {
    return null;
  }
}

function writeStoredNsec(nsecHex: string | null) {
  if (!browser) return;
  try {
    if (nsecHex) localStorage.setItem(NSEC_KEY, nsecHex);
    else localStorage.removeItem(NSEC_KEY);
  } catch {
    // Private-mode browsers can throw on storage writes. The in-memory
    // signer still works for the current page lifetime.
  }
  try { sessionStorage.removeItem(NSEC_KEY); } catch { /* private */ }
  // Mirror into the iOS shared Keychain so the DeepmarksShare
  // extension can sign + POST /publish on its own. No-op outside iOS
  // native — the JS bridge stubs to nothing on web / Android.
  void (async () => {
    try {
      const { saveSharedNsec, clearSharedNsec } = await import('$lib/native/shared-nsec');
      if (nsecHex) await saveSharedNsec(nsecHex);
      else await clearSharedNsec();
    } catch { /* tolerable — fallback to AppGroup share-drain */ }
  })();
}

function readStoredNip46Payload(): string | null {
  if (!browser) return null;
  try { return localStorage.getItem(NIP46_KEY); } catch { return null; }
}

function writeStoredNip46Payload(payload: string | null) {
  if (!browser) return;
  try {
    if (payload) localStorage.setItem(NIP46_KEY, payload);
    else localStorage.removeItem(NIP46_KEY);
  } catch {
    // The current in-memory signer still works; refresh will require reconnect.
  }
}

function readStoredAndroidSignerPayload(): string | null {
  if (!browser) return null;
  try { return localStorage.getItem(ANDROID_SIGNER_KEY); } catch { return null; }
}

function writeStoredAndroidSignerPayload(payload: string | null) {
  if (!browser) return;
  try {
    if (payload) localStorage.setItem(ANDROID_SIGNER_KEY, payload);
    else localStorage.removeItem(ANDROID_SIGNER_KEY);
  } catch {
    // The connected Android signer still works until the WebView reloads.
  }
}

function serializeNip46Signer(signer: ResolvedSigner): string | null {
  if (signer.kind !== 'nip46') return null;
  const maybe = signer.ndk as unknown as { toPayload?: () => string };
  try {
    return typeof maybe.toPayload === 'function' ? maybe.toPayload() : null;
  } catch {
    return null;
  }
}

function serializeAndroidSigner(signer: ResolvedSigner): string | null {
  if (signer.kind !== 'android') return null;
  const maybe = signer.ndk as unknown as { toPayload?: () => string };
  try {
    return typeof maybe.toPayload === 'function' ? maybe.toPayload() : null;
  } catch {
    return null;
  }
}

async function attachNdkSigner(signer: ResolvedSigner): Promise<void> {
  const { getNdk } = await import('$lib/nostr/ndk');
  getNdk().signer = signer.ndk;
}

async function clearNdkSigner(signer?: ResolvedSigner): Promise<void> {
  const { getNdk } = await import('$lib/nostr/ndk');
  const ndk = getNdk();
  if (!signer || ndk.signer === signer.ndk) ndk.signer = undefined;
}

function isNip07Available(): boolean {
  return typeof window !== 'undefined' && !!window.nostr;
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
const seededPubkey = initialPubkeyFromHint();
const internal = writable<SessionState>({ signer: null, pubkey: seededPubkey });
const restoring = writable<boolean>(!!seededPubkey);
let restoreDepth = 0;

function beginRestore() {
  restoreDepth += 1;
  restoring.set(true);
}

function endRestore() {
  restoreDepth = Math.max(0, restoreDepth - 1);
  if (restoreDepth === 0) restoring.set(false);
}

function clearRestoreState() {
  restoreDepth = 0;
  restoring.set(false);
}

export const session = {
  subscribe: internal.subscribe,
  // Getter — re-reads localStorage on every access. Was a snapshot at
  // module init, which broke navigation back to "/" after sign-in: the
  // homepage checked session.hint, saw the stale null, didn't redirect,
  // and dumped the user on the marketing page as if logged out.
  get hint(): SessionHint | null {
    return readHint();
  },
  async login(signer: ResolvedSigner, options: LoginOptions = {}) {
    const npub = nip19.npubEncode(signer.pubkey);
    writeHint({ kind: signer.kind, npub });
    if (
      signer.kind === 'nsec' &&
      signer.nsecHex &&
      (options.persistNsec === true || options.cacheNsecInTab === true)
    ) {
      writeStoredNsec(signer.nsecHex);
      clearStoredNip46Payload();
      clearStoredAndroidSignerPayload();
    } else if (signer.kind === 'nip46') {
      clearStoredNsec();
      writeStoredNip46Payload(serializeNip46Signer(signer));
      clearStoredAndroidSignerPayload();
    } else if (signer.kind === 'android') {
      clearStoredNsec();
      clearStoredNip46Payload();
      writeStoredAndroidSignerPayload(serializeAndroidSigner(signer));
    } else {
      clearStoredNsec();
      clearStoredNip46Payload();
      clearStoredAndroidSignerPayload();
    }
    // Attach to the shared NDK pool so publishes are signed automatically.
    await attachNdkSigner(signer);
    internal.set({ signer, pubkey: signer.pubkey });
    clearRestoreState();
  },
  /** Attach a signer for the current tab without writing the persistent
   *  session hint. Used during passkey enrollment: the register endpoint
   *  needs NIP-98 auth, but a failed enrollment must not leave a stale
   *  "signed in" hint that redirects the user into /app/bookmarks without a live
   *  signer after reload. */
  async attachEphemeral(signer: ResolvedSigner) {
    await attachNdkSigner(signer);
    internal.set({ signer, pubkey: signer.pubkey });
    clearRestoreState();
  },
  async clearEphemeral(signer?: ResolvedSigner) {
    const state = get(internal);
    if (signer && state.signer !== signer) return;
    const cleared = clearNdkSigner(signer);
    internal.set({ signer: null, pubkey: initialPubkeyFromHint() });
    clearRestoreState();
    await cleared;
  },
  async logout() {
    writeHint(null);
    clearStoredNsec();
    clearStoredNip46Payload();
    clearStoredAndroidSignerPayload();
    const cleared = clearNdkSigner();
    internal.set({ signer: null, pubkey: null });
    clearRestoreState();
    await cleared;
  },
  /**
   * Restore session on page load from the persisted hint.
   *
   * - NIP-07: silently re-authorize via the extension.
   * - Nsec: restore the browser-stored nsec when present; otherwise pubkey
   *   only. The UI offers passkey unlock, extension signer, or recovery-key
   *   sign-in.
   * - NIP-46: restore the pairing payload when present; otherwise pubkey only.
   */
  async rehydrate() {
    if (!browser) {
      clearRestoreState();
      return;
    }
    const hint = readHint();
    if (!hint) {
      clearRestoreState();
      return;
    }
    beginRestore();
    // Race protection: rehydrate() is fired from +layout onMount without
    // an await. If the user lands on /login and triggers a sign-in flow
    // before rehydrate finishes (NIP-07 prompt, passkey OS picker, etc.),
    // session.login may have already attached a signer. We must NOT
    // clobber that with a `internal.set({ signer: null, pubkey })` at
    // the end of this function — bail at every store-write point if a
    // signer has appeared while we were async-waiting.
    const hasSignerNow = () => get(internal).signer !== null;
    const clearStaleHintState = () => {
      if (hasSignerNow()) return;
      const currentHint = readHint();
      if (currentHint?.kind === hint.kind && currentHint.npub === hint.npub) {
        writeHint(null);
        clearStoredNsec();
        clearStoredNip46Payload();
        clearStoredAndroidSignerPayload();
      }
      void clearNdkSigner();
      internal.set({ signer: null, pubkey: null });
    };
    try {
      const decoded = nip19.decode(hint.npub);
      if (decoded.type !== 'npub') {
        clearStaleHintState();
        return;
      }
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
        const {
          createDeepmarksExtensionSigner,
          createNip07Signer,
          isDeepmarksExtensionAvailable,
        } = await import('$lib/nostr/signers/nip07');
        const signer = isDeepmarksExtensionAvailable()
          ? await createDeepmarksExtensionSigner()
          : await createNip07Signer();
        if (hasSignerNow()) return;
        if (signer.pubkey !== pubkey) {
          internal.set({ signer: null, pubkey });
          return;
        }
        await attachNdkSigner(signer);
        internal.set({ signer, pubkey: signer.pubkey });
      } else if (hint.kind === 'nsec') {
        let nsecHex = readStoredNsec();
        if (!nsecHex) {
          try {
            const { loadMobileSignerAccount } = await import('$lib/mobile/signer-account');
            const mobileAccount = await loadMobileSignerAccount();
            if (mobileAccount?.pubkey === pubkey) nsecHex = mobileAccount.nsecHex;
          } catch {
            // Native bridge unavailable or locked; keep the pubkey-only session hint.
          }
        }
        if (nsecHex) {
          try {
            const { createNsecSigner } = await import('$lib/nostr/signers/nsec');
            const signer = await createNsecSigner(nsecHex);
            if (hasSignerNow()) return;
            if (signer.pubkey !== pubkey) {
              clearStaleHintState();
              return;
            }
            await attachNdkSigner(signer);
            internal.set({ signer, pubkey: signer.pubkey });
            return;
          } catch {
            clearStoredNsec();
          }
        }
        if (hasSignerNow()) return;
        internal.set({ signer: null, pubkey });
      } else if (hint.kind === 'nip46') {
        const payload = readStoredNip46Payload();
        if (payload) {
          try {
            const { createNip46SignerFromPayload } = await import('$lib/nostr/signers/nip46');
            const signer = await createNip46SignerFromPayload(payload);
            if (hasSignerNow()) return;
            if (signer.pubkey !== pubkey) {
              clearStaleHintState();
              return;
            }
            await attachNdkSigner(signer);
            internal.set({ signer, pubkey: signer.pubkey });
            return;
          } catch {
            // Keep the public session. The remote signer may simply be offline;
            // the UI can ask the user to reconnect when a signed action is needed.
          }
        }
        if (hasSignerNow()) return;
        internal.set({ signer: null, pubkey });
      } else if (hint.kind === 'android') {
        const payload = readStoredAndroidSignerPayload();
        if (payload) {
          try {
            const { createAndroidSignerFromPayload } = await import('$lib/nostr/signers/android');
            const signer = await createAndroidSignerFromPayload(payload);
            if (hasSignerNow()) return;
            if (signer.pubkey !== pubkey) {
              clearStaleHintState();
              return;
            }
            await attachNdkSigner(signer);
            internal.set({ signer, pubkey: signer.pubkey });
            return;
          } catch {
            clearStoredAndroidSignerPayload();
          }
        }
        if (hasSignerNow()) return;
        internal.set({ signer: null, pubkey });
      } else {
        // future kinds: pubkey only, UI reconnects.
        if (hasSignerNow()) return;
        internal.set({ signer: null, pubkey });
      }
    } catch {
      // Bad hint — drop it (and any paired nsec) so next visit is clean.
      clearStaleHintState();
    } finally {
      endRestore();
    }
  }
};

export function isTransientSignerConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /could not establish connection|receiving end does not exist|extension context invalidated|message port closed|disconnected port|context was invalidated/i.test(message);
}

export async function refreshBrowserExtensionSigner(pubkey: string): Promise<boolean> {
  if (!browser || !isNip07Available()) return false;
  try {
    const {
      createDeepmarksExtensionSigner,
      createNip07Signer,
      isDeepmarksExtensionAvailable,
    } = await import('$lib/nostr/signers/nip07');
    const signer = isDeepmarksExtensionAvailable()
      ? await createDeepmarksExtensionSigner()
      : await createNip07Signer();
    if (signer.pubkey !== pubkey) return false;
    writeHint({ kind: 'nip07', npub: nip19.npubEncode(pubkey) });
    clearStoredNsec();
    clearStoredNip46Payload();
    clearStoredAndroidSignerPayload();
    await attachNdkSigner(signer);
    internal.set({ signer, pubkey });
    clearRestoreState();
    return true;
  } catch {
    return false;
  }
}

export const npub = derived(internal, ($s) =>
  $s.pubkey ? nip19.npubEncode($s.pubkey) : null
);
export const isAuthenticated = derived(internal, ($s) => !!$s.pubkey);
export const canSign = derived(internal, ($s) => !!$s.signer);
export const sessionRestoring = {
  subscribe: restoring.subscribe,
};

export function currentSession(): SessionState {
  return get(internal);
}
