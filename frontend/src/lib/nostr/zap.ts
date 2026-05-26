// NIP-57 zap flow for public bookmarks.
// Current product policy: one invoice per zap. It goes to the bookmark
// curator when their profile has a Lightning address; otherwise it falls
// back to Deepmarks. No site-operator invoice is created. Receipts are
// produced by the recipient's LNURL endpoint — we build and sign the
// kind:9734 zap request, forward it to the callback, then hand the
// resulting BOLT-11 invoice to the user's wallet or QR/manual payment flow.

import { NDKEvent } from '@nostr-dev-kit/ndk';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { bech32 } from '@scure/base';
import { decode as decodeBolt11 } from 'light-bolt11-decoder';
import { getNdk } from './ndk.js';
import { KIND } from './kinds.js';
import { config } from '$lib/config.js';
import type { ParsedBookmark } from './bookmarks.js';

const HEX_PUBKEY_RE = /^[0-9a-f]{64}$/;
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

export interface ZapRecipient {
  /** Display label for the UI. */
  label: string;
  /** LNURL or lightning address (`name@domain`). */
  lightning: string;
  /** Pubkey for the kind:9734 zap request, where known. */
  pubkey?: string;
  /** Allocation in millisats. */
  millisats: number;
}

export interface ZapPlan {
  totalMsats: number;
  recipients: ZapRecipient[];
}

export interface ZapInvoice {
  recipient: ZapRecipient;
  invoice: string; // BOLT-11
}

type ZapBookmarkTarget = Pick<ParsedBookmark, 'eventId'> & {
  source?: string;
  sourceEventId?: string;
  sourceEventKind?: number;
};

function tagValues(tags: string[][], name: string): string[] {
  return tags
    .filter((t) => t[0] === name && typeof t[1] === 'string' && t[1].length > 0)
    .map((t) => t[1] as string);
}

function readRawTags(value: unknown): string[][] {
  if (!Array.isArray(value)) return [];
  const out: string[][] = [];
  for (const tag of value) {
    if (!Array.isArray(tag) || tag.some((cell) => typeof cell !== 'string')) continue;
    out.push(tag as string[]);
  }
  return out;
}

/**
 * Extract bookmark event ids from a paid zap receipt authored by or for
 * `zapperPubkey`. The public receipt is the durable signal: many NIP-57
 * clients, including Deepmarks, send the kind:9734 zap request to the LNURL
 * callback without publishing it as a standalone relay event.
 */
export function zappedBookmarkEventIdsFromReceipt(
  receiptTags: string[][],
  zapperPubkey: string,
): string[] {
  const sender = receiptTags.find((t) => t[0] === 'P')?.[1];
  if (sender && sender !== zapperPubkey) return [];

  const description = receiptTags.find((t) => t[0] === 'description')?.[1];
  if (!description) return sender === zapperPubkey ? Array.from(new Set(tagValues(receiptTags, 'e'))) : [];

  let zapRequest: unknown;
  try {
    zapRequest = JSON.parse(description);
  } catch {
    return [];
  }
  if (!zapRequest || typeof zapRequest !== 'object' || Array.isArray(zapRequest)) return [];

  const raw = zapRequest as Record<string, unknown>;
  if (raw.pubkey !== zapperPubkey) return [];

  const ids = new Set<string>(tagValues(readRawTags(raw.tags), 'e'));
  for (const id of tagValues(receiptTags, 'e')) ids.add(id);
  return [...ids];
}

/**
 * Build the tag set for a kind:9734 zap request. Conditional fields are
 * added in order so the assembly is read-once-and-obvious; we never produce
 * an empty-string tag that the relay would reject.
 */
export function buildZapRequestTags(
  recipient: ZapRecipient,
  bookmark: ZapBookmarkTarget,
  lnurl: string,
  recipientPubkey: string,
): string[][] {
  const tags: string[][] = [
    ['p', recipientPubkey],
    ['relays', config.deepmarksRelay, ...config.defaultRelays],
    ['amount', String(recipient.millisats)],
    ['lnurl', lnurl],
  ];
  const target = zapTarget(bookmark);
  if (target) {
    tags.push(['e', target.eventId]);
    tags.push(['k', String(target.kind)]);
  }
  return tags;
}

function zapTarget(bookmark: ZapBookmarkTarget): { eventId: string; kind: number } | null {
  if (
    bookmark.source === 'nostr-note-link' &&
    bookmark.sourceEventId &&
    HEX_PUBKEY_RE.test(bookmark.sourceEventId)
  ) {
    return {
      eventId: bookmark.sourceEventId,
      kind: bookmark.sourceEventKind ?? KIND.note,
    };
  }
  if (HEX_PUBKEY_RE.test(bookmark.eventId)) {
    return {
      eventId: bookmark.eventId,
      kind: KIND.webBookmark,
    };
  }
  return null;
}

/**
 * Compute the zap recipient list. We use a single-recipient model:
 * if the curator has a Lightning address, the full user-entered amount goes
 * to that curator; otherwise the full amount goes to Deepmarks.
 */
export function planZap(
  bookmark: ParsedBookmark,
  totalSats: number,
  curatorLnAddress: string | null,
  deepmarksLnAddress = config.deepmarksLnAddress,
): ZapPlan {
  const totalMsats = totalSats * 1000;
  const recipients: ZapRecipient[] = [];

  if (totalSats <= 0) return { totalMsats, recipients };

  if (curatorLnAddress) {
    recipients.push({
      label: curatorLnAddress,
      lightning: curatorLnAddress,
      pubkey: bookmark.curator,
      millisats: totalMsats,
    });
  } else {
    recipients.push({
      label: 'deepmarks',
      lightning: deepmarksLnAddress,
      millisats: totalMsats,
    });
  }
  return { totalMsats, recipients };
}

interface LnurlPayMeta {
  callback: string;
  minSendable: number;
  maxSendable: number;
  metadata: string;
  allowsNostr?: boolean;
  nostrPubkey?: string;
  status?: string;
  reason?: string;
}

interface ResolvedLnurl {
  payUrl: string;
  lnurl: string;
  meta: LnurlPayMeta;
}

export function encodeLnurlPayUrl(payUrl: string): string {
  return bech32.encode('lnurl', bech32.toWords(utf8Encoder.encode(payUrl)), false);
}

export function decodeLnurlPayUrl(lnurl: string): string {
  const decoded = bech32.decode(lnurl.toLowerCase() as `lnurl1${string}`, false);
  if (decoded.prefix !== 'lnurl') throw new Error('LNURL must use the lnurl prefix');
  return utf8Decoder.decode(bech32.fromWords(decoded.words));
}

export function lightningAddressToPayUrl(address: string): string {
  const trimmed = address.trim();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) {
    throw new Error(`Unrecognised Lightning identifier: ${address}`);
  }
  const name = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1).toLowerCase();
  if (name.includes('/') || domain.includes('/') || /\s/.test(trimmed)) {
    throw new Error(`Unrecognised Lightning identifier: ${address}`);
  }
  return new URL(`/.well-known/lnurlp/${encodeURIComponent(name)}`, `https://${domain}`).toString();
}

function isHexPubkey(value: string | undefined): value is string {
  return !!value && HEX_PUBKEY_RE.test(value);
}

async function resolveLnurl(addrOrLnurl: string): Promise<ResolvedLnurl> {
  let payUrl: string;
  const trimmed = addrOrLnurl.trim();
  if (trimmed.includes('@')) {
    payUrl = lightningAddressToPayUrl(trimmed);
  } else if (trimmed.toLowerCase().startsWith('lnurl')) {
    payUrl = decodeLnurlPayUrl(trimmed);
  } else {
    throw new Error(`Unrecognised Lightning identifier: ${addrOrLnurl}`);
  }
  const parsed = new URL(payUrl);
  if (parsed.protocol !== 'https:') {
    throw new Error('LNURL pay URL must use https');
  }

  const res = await fetch(payUrl);
  const meta = (await readJsonResponse(res)) as unknown as LnurlPayMeta;
  if (!res.ok) {
    throw new Error(`LNURL endpoint returned ${res.status}${meta.reason ? `: ${meta.reason}` : ''}`);
  }
  if (meta.status === 'ERROR') throw new Error(meta.reason ?? 'LNURL endpoint returned an error');
  return { payUrl, lnurl: encodeLnurlPayUrl(payUrl), meta };
}

async function readJsonResponse(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!text) return {};
  try {
    const json = JSON.parse(text);
    return json && typeof json === 'object' ? json as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * Build a kind:9734 zap request and POST to the recipient's LNURL callback,
 * returning the BOLT-11 invoice. Caller hands the invoice to WebLN /
 * displays as QR.
 */
export async function fetchZapInvoice(
  recipient: ZapRecipient,
  bookmark: ParsedBookmark,
  zapperPubkey: string,
  comment = ''
): Promise<ZapInvoice> {
  if (!recipient.lightning) {
    throw new Error(`No Lightning address for ${recipient.label}`);
  }
  const resolved = await resolveLnurl(recipient.lightning);
  const { meta } = resolved;
  if (!meta.allowsNostr || !isHexPubkey(meta.nostrPubkey)) {
    throw new Error(`${recipient.label} does not advertise nostr zap support`);
  }
  if (recipient.millisats < meta.minSendable || recipient.millisats > meta.maxSendable) {
    throw new Error(
      `${recipient.label} accepts ${meta.minSendable}-${meta.maxSendable} msats, got ${recipient.millisats}`
    );
  }

  const ndk = getNdk();
  if (!ndk.signer) throw new Error('No signer attached.');
  const recipientPubkey = isHexPubkey(recipient.pubkey) ? recipient.pubkey : meta.nostrPubkey;

  // Build the zap request. The receipt's description_hash will be SHA-256 of
  // the canonical raw JSON we send — DO NOT re-serialize before sending.
  const tags = buildZapRequestTags(recipient, bookmark, resolved.lnurl, recipientPubkey);
  const zapRequest = new NDKEvent(ndk, {
    kind: KIND.zapRequest,
    pubkey: zapperPubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: comment
  });
  await zapRequest.sign();
  const rawJson = JSON.stringify(zapRequest.rawEvent());

  const callbackUrl = new URL(meta.callback);
  callbackUrl.searchParams.set('amount', String(recipient.millisats));
  callbackUrl.searchParams.set('nostr', rawJson);
  callbackUrl.searchParams.set('lnurl', resolved.lnurl);

  const res = await fetch(callbackUrl.toString());
  const data = (await readJsonResponse(res)) as { pr?: string; status?: string; reason?: string };
  if (!res.ok || data.status === 'ERROR') {
    const reason = data.reason ? `: ${data.reason}` : '';
    throw new Error(`${recipient.label} LNURL callback returned ${res.status}${reason}`);
  }
  if (!data.pr) throw new Error(data.reason ?? 'No invoice returned');
  verifyZapInvoice(data.pr, recipient.millisats, rawJson, recipient.label);
  return { recipient, invoice: data.pr };
}

export function verifyZapInvoice(
  invoice: string,
  expectedMsats: number,
  rawZapRequestJson: string,
  label = 'recipient',
): void {
  let decoded: { sections?: Array<{ name?: string; value?: unknown }> };
  try {
    decoded = decodeBolt11(invoice) as { sections?: Array<{ name?: string; value?: unknown }> };
  } catch {
    throw new Error(`${label} returned an invalid Lightning invoice`);
  }
  const sections = decoded.sections ?? [];
  const invoiceMsats = parseInvoiceMsats(sections.find((s) => s.name === 'amount')?.value);
  if (invoiceMsats === null) {
    throw new Error(`${label} returned an amountless Lightning invoice`);
  }
  const expected = BigInt(expectedMsats);
  if (invoiceMsats !== expected) {
    throw new Error(`${label} invoice amount mismatch: expected ${expected} msats, got ${invoiceMsats} msats`);
  }
  const descriptionHash = sections.find((s) => s.name === 'description_hash')?.value;
  if (typeof descriptionHash !== 'string' || !/^[0-9a-f]{64}$/i.test(descriptionHash)) {
    throw new Error(`${label} invoice is missing the zap request description hash`);
  }
  const expectedHash = bytesToHex(sha256(utf8Encoder.encode(rawZapRequestJson)));
  if (descriptionHash.toLowerCase() !== expectedHash) {
    throw new Error(`${label} invoice description hash does not match the signed zap request`);
  }
}

function parseInvoiceMsats(value: unknown): bigint | null {
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'bigint' && value >= 0n) return value;
  return null;
}

/** Fetch all invoices in parallel; throws if any single recipient fails. */
export async function fetchAllZapInvoices(
  plan: ZapPlan,
  bookmark: ParsedBookmark,
  zapperPubkey: string,
  comment = ''
): Promise<ZapInvoice[]> {
  const results = await Promise.allSettled(
    plan.recipients.map((r) => fetchZapInvoice(r, bookmark, zapperPubkey, comment))
  );
  const failures = results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => r.reason instanceof Error ? r.reason.message : String(r.reason));
  if (failures.length) throw new Error(failures.join('; '));
  return results.map((r) => (r as PromiseFulfilledResult<ZapInvoice>).value);
}

declare global {
  interface Window {
    webln?: {
      enable: () => Promise<void>;
      sendPayment: (invoice: string) => Promise<{ preimage: string }>;
    };
  }
}

type DeepmarksBridgeReply = {
  id?: string;
  source?: string;
  result?: unknown;
  error?: string;
};

const DEEPMARKS_BRIDGE_TIMEOUT_MS = 70_000;

/**
 * Manual-payment fallback: thrown when neither NWC nor WebLN is wired
 * up. Carries the BOLT-11 invoices so the calling UI can render
 * a copy/QR view for the user to pay in their preferred wallet.
 */
export class ManualPaymentRequired extends Error {
  constructor(public readonly invoices: ZapInvoice[]) {
    super('manual payment required — no wallet connected');
    this.name = 'ManualPaymentRequired';
  }
}

export class ZapPaymentFailed extends Error {
  constructor(
    message: string,
    /** Invoices not confirmed by this client. The first one may have reached the wallet if the failure was a timeout. */
    public readonly invoices: ZapInvoice[],
    /** Invoices already confirmed with preimages before the failure. */
    public readonly paidPreimages: string[],
  ) {
    super(message);
    this.name = 'ZapPaymentFailed';
  }
}

export function lightningUriForInvoice(invoice: string): string {
  return `lightning:${invoice.trim()}`;
}

/**
 * Pay a list of BOLT-11 invoices using whichever wallet path is
 * available, in priority order:
 *   1. NWC (configured in Settings) — works on every browser, no
 *      extension needed; preferred path because the user has
 *      explicitly opted in.
 *   2. Deepmarks extension bridge — reaches the extension's NWC even
 *      when page-world WebLN injection is unavailable.
 *   3. WebLN (Alby, Mutiny browser extension, etc.) — convenient
 *      when the user already has another wallet extension installed.
 *   4. Throw ManualPaymentRequired so the UI can show the invoices
 *      for the user to pay externally.
 *
 * Returns the array of preimages (one per invoice) on success.
 */
export async function payInvoices(invoices: ZapInvoice[]): Promise<string[]> {
  const { loadNwc } = await import('./nwc-store.js');
  let hasSiteNwc = false;
  try {
    hasSiteNwc = !!(await loadNwc());
  } catch {
    hasSiteNwc = false;
  }
  if (hasSiteNwc) {
    const { payInvoice } = await import('./nwc.js');
    try {
      return await paySequentialInvoices(invoices, async (inv) => (await payInvoice(inv.invoice)).preimage);
    } catch (e) {
      if (!canTryNextPaymentTransport(e)) throw e;
    }
  }

  if (await hasDeepmarksExtensionBridge()) {
    try {
      return await paySequentialInvoices(invoices, async (inv) => {
        const result = await callDeepmarksExtensionBridge('webln.sendPayment', [inv.invoice]);
        const preimage = (result as { preimage?: unknown })?.preimage;
        if (typeof preimage !== 'string') throw new Error('Deepmarks extension returned invalid payment response');
        return preimage;
      });
    } catch (e) {
      if (!canTryNextPaymentTransport(e)) throw e;
    }
  }

  if (typeof window !== 'undefined' && window.webln) {
    try {
      await window.webln.enable();
      return await paySequentialInvoices(invoices, async (inv) => {
        const { preimage } = await window.webln!.sendPayment(inv.invoice);
        return preimage;
      });
    } catch (e) {
      if (!canTryNextPaymentTransport(e)) throw e;
    }
  }

  throw new ManualPaymentRequired(invoices);
}

function canTryNextPaymentTransport(error: unknown): boolean {
  if (error instanceof ZapPaymentFailed && error.paidPreimages.length > 0) return false;
  const message = ((error as Error).message ?? '').toLowerCase();
  return (
    message.includes('no wallet connected') ||
    message.includes('wallet is not connected') ||
    message.includes('no nwc wallet connected') ||
    message.includes('nwc wallet is not connected') ||
    message.includes('extension bridge not detected') ||
    message.includes('unsupported nip-07 method: webln.sendpayment')
  );
}

async function paySequentialInvoices(
  invoices: ZapInvoice[],
  pay: (invoice: ZapInvoice) => Promise<string>,
): Promise<string[]> {
  const preimages: string[] = [];
  for (let i = 0; i < invoices.length; i += 1) {
    try {
      const preimage = await pay(invoices[i]!);
      if (!/^[0-9a-f]{64}$/i.test(preimage)) throw new Error('wallet returned invalid preimage');
      preimages.push(preimage);
    } catch (e) {
      throw new ZapPaymentFailed(
        (e as Error).message ?? 'payment failed',
        invoices.slice(i),
        preimages,
      );
    }
  }
  return preimages;
}

async function hasDeepmarksExtensionBridge(): Promise<boolean> {
  try {
    await callDeepmarksExtensionBridge('deepmarks.ping', [], 300);
    return true;
  } catch (e) {
    // Older extension builds answer unknown methods with an explicit
    // "unsupported" error; that still proves the isolated bridge is
    // present, even if the MAIN-world window.webln provider is not.
    return (e as Error).message.includes('unsupported NIP-07 method');
  }
}

function callDeepmarksExtensionBridge(
  method: string,
  params: unknown[],
  timeoutMs = DEEPMARKS_BRIDGE_TIMEOUT_MS,
): Promise<unknown> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no browser window'));
  const id = `dm-site-webln-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const origin = window.location.origin;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error('Deepmarks extension bridge not detected'));
    }, timeoutMs);

    function settle(fn: () => void) {
      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      fn();
    }

    function onMessage(event: MessageEvent) {
      if (event.source !== window || event.origin !== origin) return;
      const data = event.data as DeepmarksBridgeReply | null;
      if (!data || data.source !== 'deepmarks-nip07-response' || data.id !== id) return;
      settle(() => {
        if (data.error) reject(new Error(data.error));
        else resolve(data.result);
      });
    }

    window.addEventListener('message', onMessage);
    window.postMessage({ source: 'deepmarks-nip07', id, method, params }, origin);
  });
}

/** @deprecated Use payInvoices() — auto-routes through NWC when
 *  configured, falls back to WebLN, then to manual payment. */
export const payInvoicesWithWebLN = payInvoices;
