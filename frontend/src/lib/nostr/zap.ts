// NIP-57 zap flow with 3-way split for public bookmarks.
// CLAUDE.md: 80% curator · 10% site operator (if detectable) · 10% deepmarks.
// Receipts are produced by the recipients' LNURL endpoints — we just build &
// sign the kind:9734 zap request and forward to each callback. The wallet
// pays the three resulting BOLT-11 invoices.

import { NDKEvent } from '@nostr-dev-kit/ndk';
import { getNdk } from './ndk.js';
import { KIND } from './kinds.js';
import { config } from '$lib/config.js';
import type { ParsedBookmark } from './bookmarks.js';

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

/**
 * Build the tag set for a kind:9734 zap request. Conditional fields are
 * added in order so the assembly is read-once-and-obvious; we never produce
 * an empty-string tag that the relay would reject.
 */
export function buildZapRequestTags(
  recipient: ZapRecipient,
  bookmark: Pick<ParsedBookmark, 'eventId'>
): string[][] {
  const tags: string[][] = [
    ['relays', config.deepmarksRelay, ...config.defaultRelays],
    ['amount', String(recipient.millisats)],
    ['lnurl', recipient.lightning]
  ];
  if (recipient.pubkey) tags.push(['p', recipient.pubkey]);
  if (bookmark.eventId) tags.push(['e', bookmark.eventId]);
  return tags;
}

/**
 * Compute the 3-way split. When a recipient's Lightning address is missing,
 * their share rolls into the deepmarks leg rather than causing the whole
 * zap to fail — so:
 *   - curator LN + operator LN known → [curator 80%, operator 10%, deepmarks 10%]
 *   - curator LN known, operator LN missing → [curator 80%, deepmarks 20%]
 *   - curator LN missing, operator LN known → [operator 10%, deepmarks 90%]
 *   - both missing → [deepmarks 100%]
 *
 * Every leg is rounded to whole sats. LNURL callbacks reject amounts that
 * aren't multiples of 1000 msats — so a 21-sat zap can't send 16.8 sats
 * to the curator and 4.2 to deepmarks. Instead, curator and operator
 * legs get Math.round(share) sats; deepmarks picks up whatever's left so
 * the total the wallet pays matches the user's input exactly. Any leg
 * that rounds to zero sats is dropped (sub-sat LN payments aren't a
 * thing) — its share rolls into deepmarks via the remainder calculation.
 */
export function planZap(
  bookmark: ParsedBookmark,
  totalSats: number,
  deepmarksLnAddress: string,
  curatorLnAddress: string | null,
): ZapPlan {
  const totalMsats = totalSats * 1000;

  // Allocate each non-deepmarks leg in whole sats so LNURL callbacks
  // accept the amount. Rounding in sat-space guarantees multiples of
  // 1000 msats.
  const curatorSats = curatorLnAddress ? Math.round(totalSats * 0.8) : 0;
  const operatorSats = bookmark.lightning ? Math.round(totalSats * 0.1) : 0;

  const recipients: ZapRecipient[] = [];

  if (curatorLnAddress && curatorSats > 0) {
    recipients.push({
      label: curatorLnAddress,
      lightning: curatorLnAddress,
      pubkey: bookmark.curator,
      millisats: curatorSats * 1000,
    });
  }

  if (bookmark.lightning && operatorSats > 0) {
    recipients.push({
      label: bookmark.lightning,
      lightning: bookmark.lightning,
      millisats: operatorSats * 1000,
    });
  }

  // Deepmarks absorbs (a) its 10% base share, (b) any share from legs we
  // couldn't pay, and (c) rounding adjustments from the whole-sat
  // rounding above. Computing from the remainder keeps the total
  // exactly at totalMsats no matter how many legs exist.
  const takenMsats = recipients.reduce((sum, r) => sum + r.millisats, 0);
  const deepmarksMsats = totalMsats - takenMsats;
  if (deepmarksMsats > 0) {
    recipients.push({
      label: 'deepmarks',
      lightning: deepmarksLnAddress,
      millisats: deepmarksMsats,
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
}

async function resolveLnurl(addrOrLnurl: string): Promise<LnurlPayMeta> {
  let url: string;
  if (addrOrLnurl.includes('@')) {
    const [name, domain] = addrOrLnurl.split('@');
    url = `https://${domain}/.well-known/lnurlp/${name}`;
  } else if (addrOrLnurl.toLowerCase().startsWith('lnurl')) {
    // bech32-decoded URL — beyond MVP scope. Phase 7 will add bech32 LNURLs.
    throw new Error('bech32 LNURLs not yet supported — use lightning address (name@domain)');
  } else {
    throw new Error(`Unrecognised Lightning identifier: ${addrOrLnurl}`);
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`LNURL endpoint returned ${res.status}`);
  return (await res.json()) as LnurlPayMeta;
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
  const meta = await resolveLnurl(recipient.lightning);
  if (!meta.allowsNostr || !meta.nostrPubkey) {
    throw new Error(`${recipient.label} does not advertise nostr zap support`);
  }
  if (recipient.millisats < meta.minSendable || recipient.millisats > meta.maxSendable) {
    throw new Error(
      `${recipient.label} accepts ${meta.minSendable}-${meta.maxSendable} msats, got ${recipient.millisats}`
    );
  }

  const ndk = getNdk();
  if (!ndk.signer) throw new Error('No signer attached.');

  // Build the zap request. The receipt's description_hash will be SHA-256 of
  // the canonical raw JSON we send — DO NOT re-serialize before sending.
  const tags = buildZapRequestTags(recipient, bookmark);
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
  if (comment) callbackUrl.searchParams.set('comment', comment);

  const res = await fetch(callbackUrl.toString());
  if (!res.ok) throw new Error(`LNURL callback returned ${res.status}`);
  const data = (await res.json()) as { pr?: string; reason?: string };
  if (!data.pr) throw new Error(data.reason ?? 'No invoice returned');
  return { recipient, invoice: data.pr };
}

/** Fetch all invoices in parallel; throws if any single recipient fails. */
export async function fetchAllZapInvoices(
  plan: ZapPlan,
  bookmark: ParsedBookmark,
  zapperPubkey: string,
  comment = ''
): Promise<ZapInvoice[]> {
  return Promise.all(
    plan.recipients.map((r) => fetchZapInvoice(r, bookmark, zapperPubkey, comment))
  );
}

declare global {
  interface Window {
    webln?: {
      enable: () => Promise<void>;
      sendPayment: (invoice: string) => Promise<{ preimage: string }>;
    };
  }
}

/** Pay a list of invoices via WebLN; returns the array of preimages. */
export async function payInvoicesWithWebLN(invoices: ZapInvoice[]): Promise<string[]> {
  if (!window.webln) {
    throw new Error('No WebLN provider detected. Install Alby or another Lightning extension.');
  }
  await window.webln.enable();
  const preimages: string[] = [];
  for (const inv of invoices) {
    const { preimage } = await window.webln.sendPayment(inv.invoice);
    preimages.push(preimage);
  }
  return preimages;
}
