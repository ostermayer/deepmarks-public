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
  getReadRelays,
  getSettings,
  rememberLoginForever,
  touchSavedLogin,
} from '../lib/settings-store.js';

// ─── Pending NIP-07 requests ──────────────────────────────────────────
// When the user has to approve a request, we stash the in-flight
// request here so the popup's Sign-Request screen can fetch it,
// the user decides, and we replay the resolution back to the content
// script. Cleared as soon as either side resolves.

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
// memory only; cleared when the service worker is recycled.
const sessionGrants = new Map<string, { kinds: 'all' | number[]; expiresAt: number | null }>();

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

// ─── Boot log ─────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  const s = await nsecStore.getState();
  console.info(
    '[deepmarks] background ready,',
    s.empty   ? 'no nsec yet'
    : s.locked ? `locked account ${s.pubkey?.slice(0, 12)}…`
              : `signed in as ${s.pubkey?.slice(0, 12)}…`,
  );
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
  return false;
});

// ─── Core NIP-07 handler ──────────────────────────────────────────────

type RememberChoice = 'just-once' | 'until-close' | 'one-hour' | 'forever';

async function handleNip07(msg: {
  id: string; method: string; params: unknown[]; origin: string; title: string;
}): Promise<{ result?: unknown; error?: string }> {
  const state = await nsecStore.getState();
  if (state.empty) {
    return { error: 'Deepmarks not signed in — open the extension first' };
  }
  if (state.locked) {
    return { error: 'Deepmarks is locked — open the extension and enter your password' };
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
    msg.method === 'signEvent' &&
    isAlwaysPromptTemplate(msg.params[0]);
  if (!skipAutoApproval && await isApproved(msg.origin)) {
    return executeApprovedRequest(
      { method: msg.method, params: msg.params, origin: msg.origin },
      'just-once',
    );
  }

  // Otherwise: park the request, open the popup so the user sees the
  // Sign-Request screen, and resolve when they click Approve / Reject.
  return new Promise<{ result?: unknown; error?: string }>((resolve) => {
    admitPending({
      id: msg.id, method: msg.method, params: msg.params,
      origin: msg.origin, title: msg.title,
      resolve, createdAt: Date.now(),
    });
    // Best-effort popup open. If openPopup isn't supported, the user
    // sees a badge count and can open the popup manually.
    chrome.action.setBadgeText({ text: String(pendingRequests.size) }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: '#c96442' }).catch(() => {});
    if (chrome.action.openPopup) chrome.action.openPopup().catch(() => {});
  });
}

async function isApproved(origin: string): Promise<boolean> {
  // Forever grants live in storage.
  const settings = await getSettings();
  if (settings.savedLogins.some((l) => l.origin === origin)) {
    void touchSavedLogin(origin);
    return true;
  }
  // Session grants live in memory.
  const grant = sessionGrants.get(origin);
  if (!grant) return false;
  if (grant.expiresAt !== null && Date.now() > grant.expiresAt) {
    sessionGrants.delete(origin);
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
  applyRememberChoice(req.origin, remember);

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

  try {
    switch (req.method) {
      case 'getPublicKey':
        return { result: state.pubkey };
      case 'getRelays': {
        const relays = await getReadRelays();
        const out: Record<string, { read: boolean; write: boolean }> = {};
        for (const url of relays) out[url] = { read: true, write: true };
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

function applyRememberChoice(origin: string, choice: RememberChoice): void {
  switch (choice) {
    case 'just-once':   return;
    case 'until-close': sessionGrants.set(origin, { kinds: 'all', expiresAt: null }); return;
    case 'one-hour':    sessionGrants.set(origin, { kinds: 'all', expiresAt: Date.now() + 60 * 60 * 1000 }); return;
    case 'forever':     void rememberLoginForever(origin); return;
  }
}
