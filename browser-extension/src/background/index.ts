// Background service worker.
//
// Routes incoming chrome.runtime messages from:
//   - the NIP-07 injector content script (page → window.nostr → us)
//   - the popup (settings reads/writes pending requests)
//
// Holds zero state of its own beyond an in-memory `pendingRequests`
// map. Persistent state goes through nsec-store / settings-store.

import { finalizeEvent, type EventTemplate, type Event as NostrEvent, nip04, nip44 } from 'nostr-tools';
import { hexToBytes } from 'nostr-tools/utils';
import { nsecStore } from '../lib/nsec-store.js';
import {
  getSettings,
  rememberLoginForever,
  savedLoginMatches,
  type SavedLoginScope,
  touchSavedLogin,
} from '../lib/settings-store.js';
import { payInvoice } from '../lib/nwc.js';
import {
  clearNwc,
  loadNwc,
  parseNwcUri,
  saveNwc,
  type NwcConnection,
} from '../lib/nwc-store.js';
import {
  runLifetimeArchiveBackfill,
  startLifetimeArchiveBackfillService,
} from '../lib/lifetime-archive-backfill.js';
import {
  reconcilePendingArchiveKeys,
  startArchiveKeyReconcileService,
} from '../lib/archive-key-reconciler.js';
import { IS_APPLE_BUILD } from '../lib/build-flags.js';

// ─── Pending page-world requests ──────────────────────────────────────
// When the user has to approve a request, we stash the in-flight
// NIP-07 or WebLN request here so the popup's Sign-Request screen can
// fetch it, the user decides, and we replay the resolution back to the
// content script. Cleared as soon as either side resolves.

interface PendingRequest {
  id: string;
  method: string;
  params: unknown[];
  origin: string;
  title: string;
  /** Resolves with the final reply we'll send back to the content
   *  script. Either { result } or { error }. */
  resolve: (reply: { result?: unknown; error?: string }) => void;
  createdAt: number;
}

const pendingRequests = new Map<string, PendingRequest>();
let approvalWindowId: number | null = null;
let approvalUiOpening: Promise<void> | null = null;

// Hard caps so a malicious page can't spam signEvent calls into the
// service-worker memory (each entry holds a closure pinning the
// page-side promise resolver). MAX_AGE_MS evicts forgotten entries;
// MAX_PENDING bounds the map size with FIFO eviction.
const PENDING_MAX_AGE_MS = 5 * 60 * 1000;
const PENDING_MAX = 50;

function evictExpiredPending(): void {
  const cutoff = Date.now() - PENDING_MAX_AGE_MS;
  for (const [id, r] of pendingRequests) {
    if (r.createdAt < cutoff) {
      pendingRequests.delete(id);
      r.resolve({ error: 'request timed out — open the extension and try again' });
    }
  }
}

function admitPending(req: PendingRequest): void {
  evictExpiredPending();
  while (pendingRequests.size >= PENDING_MAX) {
    const oldest = pendingRequests.keys().next().value as string | undefined;
    if (!oldest) break;
    const r = pendingRequests.get(oldest);
    pendingRequests.delete(oldest);
    r?.resolve({ error: 'too many pending requests — older request dropped' });
  }
  pendingRequests.set(req.id, req);
}

// In-session "Until I close the browser" / "1 hour" grants. Lives in
// memory only; cleared when the service worker is recycled. Grants are
// scoped by origin + exact method, and signEvent grants are additionally
// scoped by event kind.
const sessionGrants = new Map<string, { expiresAt: number | null }>();

// Kinds that always require a fresh user prompt regardless of any
// 'until-close' / 'one-hour' / 'forever' grant. These rewrite or
// destroy persistent state, so a single approval for a low-stakes kind
// shouldn't transitively bless them. Mirrors what nos2x scopes
// per-kind in its prompt UI.
const ALWAYS_PROMPT_KINDS = new Set<number>([
  0,     // metadata / profile rewrite
  5,     // deletion request
  3,     // contact list rewrite
  10002, // relay list rewrite (NIP-65)
  13,    // sealed DM
  1059,  // gift-wrapped event
]);

const ALWAYS_PROMPT_METHODS = new Set<string>([
  // The NWC secret in chrome.storage.local can spend through the user's
  // wallet. Origin grants may enable wallet discovery, but every actual
  // payment needs a fresh click in our popup.
  'webln.sendPayment',
]);

const TRUSTED_DEEPMARKS_ORIGINS = new Set([
  'https://deepmarks.org',
  'https://www.deepmarks.org',
]);
const DEEPMARKS_FIRST_PARTY_KINDS = new Set<number>([
  30003, // encrypted private bookmark set
  39701, // public web bookmark
]);

// ─── Boot log ─────────────────────────────────────────────────────────
startLifetimeArchiveBackfillService();
startArchiveKeyReconcileService();

chrome.runtime.onInstalled.addListener(() => {
  void nsecStore.getState()
    .then((s) => {
      console.info(
        '[deepmarks] background ready,',
        s.empty   ? 'no nsec yet'
        : s.locked ? `locked account ${s.pubkey?.slice(0, 12)}…`
                  : `signed in as ${s.pubkey?.slice(0, 12)}…`,
      );
    })
    .catch((e) => {
      console.warn('[deepmarks] background started, account state unavailable', e);
    });
});

chrome.windows?.onRemoved?.addListener((windowId) => {
  if (approvalWindowId === windowId) approvalWindowId = null;
});

// ─── Message router ───────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.kind === 'nip07') {
    void handleNip07(msg).then(sendResponse);
    return true; // keep channel open for the async reply
  }
  if (msg?.kind === 'nip07-list-pending') {
    sendResponse({
      pending: [...pendingRequests.values()].map((r) => ({
        id: r.id, method: r.method, params: r.params,
        origin: r.origin, title: r.title, createdAt: r.createdAt,
      })),
    });
    return false;
  }
  if (msg?.kind === 'nip07-resolve') {
    const req = pendingRequests.get(msg.id);
    if (!req) { sendResponse({ ok: false, error: 'no such pending request' }); return false; }
    pendingRequests.delete(msg.id);
    if (msg.decision === 'reject') {
      req.resolve({ error: 'user rejected request' });
      sendResponse({ ok: true });
      return false;
    }
    void executeApprovedRequest(req, msg.remember as RememberChoice).then((reply) => {
      req.resolve(reply);
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg?.kind === 'archive-backfill-run') {
    void runLifetimeArchiveBackfill(true).then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: (err as Error).message }),
    );
    return true;
  }
  return false;
});

// ─── Core NIP-07 handler ──────────────────────────────────────────────

type RememberChoice = 'just-once' | 'until-close' | 'one-hour' | 'forever';

async function handleNip07(msg: {
  id: string; method: string; params: unknown[]; origin: string; title: string;
}): Promise<{ result?: unknown; error?: string }> {
  if (isDeepmarksPrivateMethod(msg.method)) {
    if (!TRUSTED_DEEPMARKS_ORIGINS.has(msg.origin)) {
      return { error: 'Deepmarks private extension APIs are only available on deepmarks.org' };
    }
    const state = await nsecStore.getState();
    if (state.empty) return { error: 'Deepmarks not signed in — open the extension first' };
    if (state.locked) return { error: 'Deepmarks is locked — open the extension and enter your password' };
    return executeApprovedRequest(
      { method: msg.method, params: msg.params, origin: msg.origin },
      'just-once',
    );
  }

  if (isWeblnMethod(msg.method)) {
    const conn = await loadNwcForWebln();
    if (conn && typeof conn === 'object' && 'error' in conn) return conn;
    if (!conn) {
      return { error: 'Deepmarks NWC wallet is not connected — open extension Settings and paste a Nostr Wallet Connect URI' };
    }
    if (!ALWAYS_PROMPT_METHODS.has(msg.method) && await isApproved(msg)) {
      return executeApprovedRequest(
        { method: msg.method, params: msg.params, origin: msg.origin },
        'just-once',
      );
    }
    return promptForApproval(msg);
  }

  const state = await nsecStore.getState();
  if (state.empty) {
    return { error: 'Deepmarks not signed in — open the extension first' };
  }
  if (state.locked) {
    return { error: 'Deepmarks is locked — open the extension and enter your password' };
  }

  // The first-party web app uses this extension as its signer. Large
  // private imports need several self-encrypt/sign operations; prompting
  // once per encrypted chunk is both noisy and prone to page-side timeout.
  // Keep this silent path narrow: production Deepmarks origins only,
  // self-encryption only, and bookmark/private-set event kinds only.
  if (isTrustedDeepmarksRequest(msg, state.pubkey)) {
    return executeApprovedRequest(
      { method: msg.method, params: msg.params, origin: msg.origin },
      'just-once',
    );
  }

  // Every method goes through the approval flow now — including the
  // "cheap reads" (getPublicKey, getRelays). NIP-07 spec lets reads be
  // silent, but in practice that creates a confusing UX: a Nostr web
  // app like Coracle calls getPublicKey on page load, treats the user
  // as logged in, and the user never sees a prompt. They'd then click
  // our toolbar icon expecting an auth-flow popup but land on the
  // bookmark UI instead. Alby and nos2x both prompt on first hit per
  // origin for the same reason. After the user approves once with a
  // 'forever' grant, subsequent reads ARE silent.
  //
  // signEvent additionally bypasses auto-approval for kinds that
  // rewrite persistent state (kind:0 profile, kind:3 contacts, kind:5
  // deletes, kind:1059 gift wrap, kind:13 sealed DM, kind:10002 relay
  // list) — a low-stakes 'until-close' grant shouldn't transitively
  // bless rewriting the user's profile.
  const skipAutoApproval =
    ALWAYS_PROMPT_METHODS.has(msg.method) ||
    msg.method === 'signEvent' &&
    isAlwaysPromptTemplate(msg.params[0]);
  if (!skipAutoApproval && await isApproved(msg)) {
    return executeApprovedRequest(
      { method: msg.method, params: msg.params, origin: msg.origin },
      'just-once',
    );
  }

  // Otherwise: park the request, open the popup so the user sees the
  // Sign-Request screen, and resolve when they click Approve / Reject.
  return promptForApproval(msg);
}

function promptForApproval(msg: {
  id: string; method: string; params: unknown[]; origin: string; title: string;
}): Promise<{ result?: unknown; error?: string }> {
  return new Promise<{ result?: unknown; error?: string }>((resolve) => {
    admitPending({
      id: msg.id, method: msg.method, params: msg.params,
      origin: msg.origin, title: msg.title,
      resolve, createdAt: Date.now(),
    });
    // Best-effort popup open. If openPopup isn't supported, the user
    // sees an extension-owned approval window instead of only a badge.
    chrome.action.setBadgeText({ text: String(pendingRequests.size) }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: '#c96442' }).catch(() => {});
    requestApprovalUi();
  });
}

function requestApprovalUi(): void {
  approvalUiOpening ??= openApprovalUi()
    .catch(() => undefined)
    .finally(() => {
      approvalUiOpening = null;
    });
  void approvalUiOpening;
}

async function openApprovalUi(): Promise<void> {
  // Toolbar popup (chrome.action.openPopup) is the most natural
  // surface — opens the same dropdown as clicking the pennant icon.
  // We try it first on every browser. Two known caveats:
  //
  //   - Chrome/Firefox: some NIP-07 calls aren't considered a user
  //     gesture (the SW is responding to a content-script-relayed
  //     postMessage, not a direct toolbar click), so openPopup can
  //     reject with "no active user gesture". Fall through.
  //
  //   - Safari (older versions, Safari 16/17): the openPopup call
  //     could half-attach the popover and then lock subsequent
  //     toolbar clicks. Apple has been quietly fixing this; Safari 18
  //     appears to handle it. The withSwTimeout bound below means a
  //     half-attached call won't pin approvalUiOpening forever.
  if (chrome.action?.openPopup) {
    try {
      await withSwTimeout(chrome.action.openPopup(), 1500);
      return;
    } catch {
      // On Safari the openPopup call visibly opens the toolbar
      // dropdown but its promise never settles — our timeout fires
      // even though the popup is already on-screen. Falling through
      // to chrome.windows.create here would render a second, floating
      // approval window stacked on top of the dropdown. Suppress that.
      // The user already sees the popup; trust it. On Chrome/Firefox
      // openPopup rejects synchronously when there's no user gesture,
      // so we still want to fall through to the windows.create
      // fallback so the prompt actually surfaces.
      if (IS_APPLE_BUILD) return;
    }
  }

  const url = chrome.runtime.getURL('src/popup/index.html');

  // Re-focus an existing approval window if we already opened one and
  // a second request just landed.
  if (approvalWindowId !== null && chrome.windows?.update) {
    try {
      await chrome.windows.update(approvalWindowId, { focused: true });
      return;
    } catch {
      approvalWindowId = null;
    }
  }

  // If openPopup didn't take, fall back to a standalone popup-type
  // window. Chrome/Firefox honor coordinates correctly and this is a
  // good approval-prompt UX. On Safari, windows.create can position
  // the window off-screen — but it's still better than nothing if
  // openPopup also refused, so we attempt it before resorting to a
  // full tab.
  if (chrome.windows?.create) {
    // Anchor the popup over the user's current browser window. Without
    // explicit left/top, Firefox's default placement is unreliable —
    // on multi-monitor or compact-window setups the popup has been
    // observed landing at negative left coordinates (off the left
    // edge of the primary display) and the user sees nothing.
    // Chrome's default is usually saner but the same fix doesn't hurt.
    //
    // Strategy: center horizontally on the focused browser window,
    // park ~1/3 down vertically, clamp both coords to >= 0 so we can
    // never silently land off-screen. (We can't query screen
    // dimensions from a SW so we don't clamp the right/bottom edges —
    // worst case the user drags it left, which is recoverable; the
    // off-the-left-edge case isn't.)
    const POPUP_W = 430;
    const POPUP_H = 640;
    let left: number | undefined;
    let top: number | undefined;
    try {
      const ref = await chrome.windows.getLastFocused();
      if (
        typeof ref?.left === 'number' && typeof ref?.top === 'number' &&
        typeof ref?.width === 'number' && typeof ref?.height === 'number'
      ) {
        left = Math.max(0, Math.floor(ref.left + (ref.width - POPUP_W) / 2));
        top = Math.max(0, Math.floor(ref.top + (ref.height - POPUP_H) / 3));
      }
    } catch {
      // No focused window — let the browser pick. Better than passing
      // bogus coords.
    }

    try {
      const win = await chrome.windows.create({
        url,
        type: 'popup',
        width: POPUP_W,
        height: POPUP_H,
        focused: true,
        ...(typeof left === 'number' ? { left } : {}),
        ...(typeof top === 'number' ? { top } : {}),
      });
      if (win && typeof win.id === 'number') {
        approvalWindowId = win.id;
        return;
      }
    } catch (err) {
      console.warn('[deepmarks] chrome.windows.create failed, falling back to tab', err);
    }
  }

  if (chrome.tabs?.create) {
    try {
      await chrome.tabs.create({ url, active: true });
    } catch (err) {
      console.warn('[deepmarks] chrome.tabs.create failed', err);
    }
  }
}

// Bound any browser-supplied promise that might hang. openPopup on
// some Chrome builds has been observed to never settle if the user
// gesture window has expired; treat a hang as a refusal so we don't
// pin approvalUiOpening and silently drop subsequent prompts.
async function withSwTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('popup-open timed out')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function isApproved(req: Pick<PendingRequest, 'origin' | 'method' | 'params'>): Promise<boolean> {
  const scope = approvalScope(req);
  if (!scope) return false;
  // Forever grants live in storage.
  const settings = await getSettings();
  if (settings.savedLogins.some((l) => savedLoginMatches(l, req.origin, scope))) {
    void touchSavedLogin(req.origin, scope);
    return true;
  }
  // Session grants live in memory.
  const key = grantKey(req.origin, scope);
  const grant = sessionGrants.get(key);
  if (!grant) return false;
  if (grant.expiresAt !== null && Date.now() > grant.expiresAt) {
    sessionGrants.delete(key);
    return false;
  }
  return true;
}

async function executeApprovedRequest(
  req: Pick<PendingRequest, 'method' | 'params' | 'origin'>,
  remember: RememberChoice,
): Promise<{ result?: unknown; error?: string }> {
  // Apply the "remember" decision before doing the work so a slow
  // signEvent can't get re-prompted by a rapid second call.
  applyRememberChoice(req, remember);

  try {
    if (req.method === 'deepmarks.ping') {
      return { result: true };
    }

    if (req.method === 'deepmarks.nwc.get') {
      const conn = await loadNwc();
      return { result: conn ? publicNwcConnection(conn) : null };
    }

    if (req.method === 'deepmarks.nwc.connect') {
      const uri = typeof req.params[0] === 'string' ? req.params[0] : '';
      const conn = parseNwcUri(uri);
      await saveNwc(conn);
      return { result: publicNwcConnection(conn) };
    }

    if (req.method === 'deepmarks.nwc.clear') {
      await clearNwc();
      return { result: true };
    }

    if (req.method === 'deepmarks.archive.reconcile') {
      return { result: await reconcilePendingArchiveKeys(true) };
    }

    if (req.method === 'webln.enable') {
      const conn = await loadNwc();
      if (!conn) return { error: 'Deepmarks NWC wallet is not connected' };
      return { result: true };
    }

    if (req.method === 'webln.getInfo') {
      const conn = await loadNwc();
      if (!conn) return { error: 'Deepmarks NWC wallet is not connected' };
      return {
        result: {
          node: {
            alias: 'Deepmarks NWC',
            pubkey: conn.walletPubkey,
          },
          methods: ['sendPayment'],
          supports: ['lightning'],
        },
      };
    }

    if (req.method === 'webln.sendPayment') {
      const invoice = validatePaymentRequest(req.params[0]);
      if (!invoice) return { error: 'invalid Lightning invoice' };
      const result = await payInvoice(invoice);
      return { result };
    }

    const state = await nsecStore.getState();
    if (state.empty) return { error: 'Deepmarks not signed in' };
    if (state.locked || !state.nsecHex) return { error: 'Deepmarks is locked — enter your password in the popup' };

    // Each crypto branch decodes its own short-lived Uint8Array from the
    // hex string and zeroes it as soon as the operation finishes.
    // Earlier shape kept one `sk` alive for the entire request lifetime
    // including async I/O — narrowing that window reduces the chance
    // raw key bytes sit in the V8 heap during a GC pause or a debugger
    // pause. The hex string itself still lives in nsec-store and is the
    // real long-lived secret; this is a defense-in-depth narrowing.
    const withSecret = async <T>(fn: (sk: Uint8Array) => Promise<T> | T): Promise<T> => {
      const sk = hexToBytes(state.nsecHex!);
      try {
        return await fn(sk);
      } finally {
        sk.fill(0);
      }
    };

    switch (req.method) {
      case 'getPublicKey':
        return { result: state.pubkey };
      case 'getRelays': {
        const { relays } = await getSettings();
        const out: Record<string, { read: boolean; write: boolean }> = {};
        for (const relay of relays) out[relay.url] = { read: relay.read, write: relay.write };
        return { result: out };
      }
      case 'signEvent': {
        const template = validateEventTemplate(req.params[0]);
        if (!template) return { error: 'invalid event template' };
        const signed = await withSecret((sk) => finalizeEvent({
          kind: template.kind,
          created_at: template.created_at ?? Math.floor(Date.now() / 1000),
          tags: template.tags,
          content: template.content,
        }, sk) as NostrEvent);
        return { result: signed };
      }
      case 'nip04.encrypt': {
        const [pubkey, plaintext] = req.params as [string, string];
        return { result: await withSecret((sk) => nip04.encrypt(sk, pubkey, plaintext)) };
      }
      case 'nip04.decrypt': {
        const [pubkey, ciphertext] = req.params as [string, string];
        return { result: await withSecret((sk) => nip04.decrypt(sk, pubkey, ciphertext)) };
      }
      case 'nip44.encrypt': {
        const [pubkey, plaintext] = req.params as [string, string];
        return { result: await withSecret((sk) => {
          const conversationKey = nip44.v2.utils.getConversationKey(sk, pubkey);
          return nip44.v2.encrypt(plaintext, conversationKey);
        }) };
      }
      case 'nip44.decrypt': {
        const [pubkey, ciphertext] = req.params as [string, string];
        return { result: await withSecret((sk) => {
          const conversationKey = nip44.v2.utils.getConversationKey(sk, pubkey);
          return nip44.v2.decrypt(ciphertext, conversationKey);
        }) };
      }
      default:
        return { error: `unknown method: ${req.method}` };
    }
  } catch (e) {
    return { error: (e as Error).message ?? 'sign failed' };
  } finally {
    if (pendingRequests.size === 0) chrome.action.setBadgeText({ text: '' }).catch(() => {});
  }
}

function isWeblnMethod(method: string): boolean {
  return method === 'webln.enable' || method === 'webln.getInfo' || method === 'webln.sendPayment';
}

function isDeepmarksPrivateMethod(method: string): boolean {
  return method === 'deepmarks.ping' ||
    method === 'deepmarks.nwc.get' ||
    method === 'deepmarks.nwc.connect' ||
    method === 'deepmarks.nwc.clear' ||
    method === 'deepmarks.archive.reconcile';
}

function publicNwcConnection(conn: NwcConnection): Omit<NwcConnection, 'appSecret'> {
  return {
    walletPubkey: conn.walletPubkey,
    relayUrl: conn.relayUrl,
    lud16: conn.lud16,
    connectedAt: conn.connectedAt,
  };
}

function validatePaymentRequest(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const invoice = raw.trim();
  if (!/^ln(bc|tb|bcrt)[0-9a-z]+$/i.test(invoice)) return null;
  return invoice;
}

async function loadNwcForWebln(): Promise<NwcConnectionLoad> {
  try {
    return await loadNwc();
  } catch (e) {
    return { error: (e as Error).message ?? 'Deepmarks NWC wallet is unavailable' };
  }
}

type NwcConnectionLoad =
  | Awaited<ReturnType<typeof loadNwc>>
  | { error: string };

function isTrustedDeepmarksRequest(
  req: Pick<PendingRequest, 'origin' | 'method' | 'params'>,
  ownPubkey: string | null | undefined,
): boolean {
  if (!ownPubkey || !TRUSTED_DEEPMARKS_ORIGINS.has(req.origin)) return false;
  if (
    req.method === 'nip04.encrypt' ||
    req.method === 'nip04.decrypt' ||
    req.method === 'nip44.encrypt' ||
    req.method === 'nip44.decrypt'
  ) {
    return req.params[0] === ownPubkey;
  }
  if (req.method === 'signEvent') {
    const raw = req.params[0];
    if (!raw || typeof raw !== 'object') return false;
    const kind = (raw as { kind?: unknown }).kind;
    if (typeof kind !== 'number') return false;
    if (kind === 27235) return isTrustedDeepmarksNip98Template(raw);
    return DEEPMARKS_FIRST_PARTY_KINDS.has(kind);
  }
  return false;
}

function isTrustedDeepmarksNip98Template(raw: object): boolean {
  const tags = (raw as { tags?: unknown }).tags;
  if (!Array.isArray(tags)) return false;
  const getTag = (name: string): string | null => {
    const tag = tags.find((t) =>
      Array.isArray(t) &&
      t[0] === name &&
      typeof t[1] === 'string'
    );
    return Array.isArray(tag) ? tag[1] as string : null;
  };
  const url = getTag('u');
  const method = getTag('method')?.toUpperCase();
  if (!url || !method) return false;
  if (method !== 'GET' && method !== 'POST') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && (
      parsed.origin === 'https://api.deepmarks.org' ||
      TRUSTED_DEEPMARKS_ORIGINS.has(parsed.origin)
    );
  } catch {
    return false;
  }
}

/** True when the event template should bypass any cached origin
 *  approval and force a fresh prompt. Defensive against malformed
 *  templates: if `kind` isn't a number, returns true (we want the
 *  prompt to surface the malformed request rather than silently sign). */
function isAlwaysPromptTemplate(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return true;
  const kind = (raw as { kind?: unknown }).kind;
  if (typeof kind !== 'number') return true;
  return ALWAYS_PROMPT_KINDS.has(kind);
}

function approvalScope(req: Pick<PendingRequest, 'method' | 'params'>): SavedLoginScope | null {
  if (req.method === 'webln.sendPayment') return null;
  if (req.method === 'signEvent') {
    const raw = req.params[0];
    if (!raw || typeof raw !== 'object') return null;
    const kind = (raw as { kind?: unknown }).kind;
    if (typeof kind !== 'number' || !Number.isInteger(kind)) return null;
    if (ALWAYS_PROMPT_KINDS.has(kind)) return null;
    return { method: 'signEvent', kind };
  }
  if (
    req.method === 'getPublicKey' ||
    req.method === 'getRelays' ||
    req.method === 'webln.enable' ||
    req.method === 'webln.getInfo'
  ) {
    return { method: req.method };
  }
  // Do not remember encryption/decryption decisions. Those prompts can
  // reveal message plaintext or grant a site ongoing decrypt capability,
  // so they should stay explicit.
  return null;
}

function grantKey(origin: string, scope: SavedLoginScope): string {
  return `${origin}\u0000${scope.method}\u0000${scope.kind ?? ''}`;
}

/** Shape-validate the page-supplied event template before we sign it.
 *  Returns null on any malformed field so finalizeEvent never sees
 *  garbage (which could otherwise produce corrupt events on relays). */
function validateEventTemplate(raw: unknown): EventTemplate | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.kind !== 'number' || !Number.isInteger(t.kind) || t.kind < 0 || t.kind > 65535) return null;
  if (t.created_at !== undefined && (typeof t.created_at !== 'number' || !Number.isInteger(t.created_at) || t.created_at < 0)) return null;
  const tags = t.tags ?? [];
  if (!Array.isArray(tags)) return null;
  for (const tag of tags) {
    if (!Array.isArray(tag)) return null;
    for (const cell of tag) if (typeof cell !== 'string') return null;
  }
  if (t.content !== undefined && typeof t.content !== 'string') return null;
  return {
    kind: t.kind,
    // EventTemplate requires created_at; finalizeEvent / signEvent
    // will respect a caller-provided value but most NIP-07 callers
    // omit it. Default to "now" when missing so we always pass a
    // valid template downstream.
    created_at: typeof t.created_at === 'number' ? t.created_at : Math.floor(Date.now() / 1000),
    tags: tags as string[][],
    content: (t.content ?? '') as string,
  };
}

function applyRememberChoice(req: Pick<PendingRequest, 'origin' | 'method' | 'params'>, choice: RememberChoice): void {
  const scope = approvalScope(req);
  if (!scope) return;
  const key = grantKey(req.origin, scope);
  switch (choice) {
    case 'just-once':   return;
    case 'until-close': sessionGrants.set(key, { expiresAt: null }); return;
    case 'one-hour':    sessionGrants.set(key, { expiresAt: Date.now() + 60 * 60 * 1000 }); return;
    case 'forever':     void rememberLoginForever(req.origin, scope); return;
  }
}
