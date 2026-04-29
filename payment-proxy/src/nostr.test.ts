import { describe, it, expect, beforeEach } from 'vitest';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
  type EventTemplate,
  type Event as NostrEvent,
} from 'nostr-tools';
import {
  validateZapRequest,
  buildZapReceipt,
  buildLifetimeLabel,
  LIFETIME_LABEL_NAMESPACE,
  LIFETIME_LABEL_VALUE,
  ZapValidationError,
} from './nostr.js';
import type { RemoteSigner } from './signer.js';
import type { PendingZap, ZapRequestEvent } from './types.js';

/** Synchronous in-process signer for tests — skips the bunker round-trip. */
class LocalTestSigner implements RemoteSigner {
  readonly pubkey: string;
  constructor(private readonly sk: Uint8Array) {
    this.pubkey = getPublicKey(sk);
  }
  async sign(template: EventTemplate): Promise<NostrEvent> {
    return finalizeEvent(template, this.sk);
  }
  close(): void {
    /* no-op */
  }
}

function makeSigner(): LocalTestSigner {
  return new LocalTestSigner(generateSecretKey());
}

function makeZapRequest(opts: {
  amountMsat?: number;
  recipientPubkey?: string;
  eventId?: string;
} = {}): ZapRequestEvent & { rawJson: string } {
  const sk = generateSecretKey();
  const tags: string[][] = [
    ['p', opts.recipientPubkey ?? 'a'.repeat(64)],
    ['relays', 'wss://relay.test'],
    ['amount', String(opts.amountMsat ?? 21000)]
  ];
  if (opts.eventId) tags.push(['e', opts.eventId]);
  const signed = finalizeEvent(
    {
      kind: 9734,
      created_at: Math.floor(Date.now() / 1000),
      content: 'thanks',
      tags
    },
    sk
  ) as ZapRequestEvent;
  const rawJson = JSON.stringify(signed);
  return Object.assign(signed, { rawJson });
}

describe('validateZapRequest', () => {
  it('returns the event when everything is valid', () => {
    const zr = makeZapRequest({ amountMsat: 21000 });
    expect(() => validateZapRequest(zr, 21000)).not.toThrow();
  });

  it('rejects non-objects and wrong kinds', () => {
    expect(() => validateZapRequest(null, 100)).toThrow(ZapValidationError);
    expect(() => validateZapRequest('string', 100)).toThrow(ZapValidationError);
    const wrongKind = makeZapRequest();
    (wrongKind as unknown as { kind: number }).kind = 1;
    expect(() => validateZapRequest(wrongKind, 100)).toThrow(/kind must be 9734/);
  });

  it('rejects missing or wrong-length sig / pubkey', () => {
    const zr = makeZapRequest();
    (zr as unknown as { sig: string }).sig = 'too short';
    expect(() => validateZapRequest(zr, 21000)).toThrow(/sig/);
  });

  it('rejects events whose signature does not verify', () => {
    const zr = makeZapRequest();
    // nostr-tools' finalizeEvent stamps a `verifiedSymbol` own property on
    // the returned object, which verifyEvent uses as a short-circuit. JSON
    // round-trip strips it, simulating what arrives over the wire.
    const overWire = JSON.parse(JSON.stringify(zr));
    overWire.id = 'a'.repeat(64); // sig is now invalid for this fake id
    expect(() => validateZapRequest(overWire, 21000)).toThrow(/signature/);
  });

  it('requires exactly one p tag with a valid pubkey', () => {
    const zr = makeZapRequest();
    (zr as unknown as { tags: string[][] }).tags = zr.tags.filter((t) => t[0] !== 'p');
    expect(() => validateZapRequest(zr, 21000)).toThrow(/p tag/);
  });

  it('rejects when amount tag disagrees with callback amount', () => {
    const zr = makeZapRequest({ amountMsat: 21000 });
    expect(() => validateZapRequest(zr, 9999)).toThrow(/amount/);
  });

  it('requires a relays tag so the receipt has somewhere to land', () => {
    const zr = makeZapRequest();
    (zr as unknown as { tags: string[][] }).tags = zr.tags.filter((t) => t[0] !== 'relays');
    expect(() => validateZapRequest(zr, 21000)).toThrow(/relays/);
  });
});

describe('buildZapReceipt — CLAUDE.md MUST-rules', () => {
  const signer = makeSigner();
  const paidAt = 1700000000;

  function pending(zr: ReturnType<typeof makeZapRequest>): PendingZap {
    return {
      paymentHash: 'h',
      invoice: 'lnbc1...',
      zapRequest: zr,
      rawZapRequest: zr.rawJson,
      amountMsat: 21000,
      createdAt: 0,
      relays: ['wss://relay.test']
    };
  }

  it('description tag contains the EXACT raw JSON of the zap request', async () => {
    const zr = makeZapRequest({ recipientPubkey: signer.pubkey });
    const receipt = await buildZapReceipt(pending(zr), paidAt, undefined, signer);
    const desc = receipt.tags.find((t) => t[0] === 'description')?.[1];
    expect(desc).toBe(zr.rawJson);
  });

  it('created_at equals invoice paid_at (NIP-57 hard requirement)', async () => {
    const zr = makeZapRequest({ recipientPubkey: signer.pubkey });
    const receipt = await buildZapReceipt(pending(zr), paidAt, undefined, signer);
    expect(receipt.created_at).toBe(paidAt);
  });

  it('signed by the signer pubkey (matches the LNURL nostrPubkey)', async () => {
    const zr = makeZapRequest({ recipientPubkey: signer.pubkey });
    const receipt = await buildZapReceipt(pending(zr), paidAt, undefined, signer);
    expect(receipt.pubkey).toBe(signer.pubkey);
    expect(receipt.kind).toBe(9735);
    expect(receipt.content).toBe('');
    expect(verifyEvent(receipt)).toBe(true);
  });

  it('copies p, e, and P tags forward from the zap request', async () => {
    const zr = makeZapRequest({
      recipientPubkey: signer.pubkey,
      eventId: 'c'.repeat(64)
    });
    const receipt = await buildZapReceipt(pending(zr), paidAt, undefined, signer);
    expect(receipt.tags.find((t) => t[0] === 'p')?.[1]).toBe(signer.pubkey);
    expect(receipt.tags.find((t) => t[0] === 'e')?.[1]).toBe('c'.repeat(64));
    expect(receipt.tags.find((t) => t[0] === 'P')?.[1]).toBe(zr.pubkey);
  });

  it('attaches preimage tag only when provided', async () => {
    const zr = makeZapRequest({ recipientPubkey: signer.pubkey });
    const without = await buildZapReceipt(pending(zr), paidAt, undefined, signer);
    expect(without.tags.find((t) => t[0] === 'preimage')).toBeUndefined();
    const withPre = await buildZapReceipt(pending(zr), paidAt, 'preimage-hex', signer);
    expect(withPre.tags.find((t) => t[0] === 'preimage')?.[1]).toBe('preimage-hex');
  });

  it('refuses to sign when the recipient p tag does not match the signer', async () => {
    const zr = makeZapRequest({ recipientPubkey: 'd'.repeat(64) });
    await expect(buildZapReceipt(pending(zr), paidAt, undefined, signer))
      .rejects.toThrow(/does not match recipient/);
  });
});

describe('buildLifetimeLabel (NIP-32)', () => {
  let signer: LocalTestSigner;
  beforeEach(() => {
    signer = makeSigner();
  });

  it('produces a kind:1985 event signed by the brand signer', async () => {
    const e = await buildLifetimeLabel(signer, { memberPubkey: 'a'.repeat(64), paidAt: 1_700_000_000 });
    expect(e.kind).toBe(1985);
    expect(e.pubkey).toBe(signer.pubkey);
    expect(verifyEvent(e)).toBe(true);
  });

  it('embeds NIP-32 label namespace + value + subject pubkey', async () => {
    const e = await buildLifetimeLabel(signer, { memberPubkey: 'b'.repeat(64), paidAt: 1_700_000_000 });
    expect(e.tags.find((t) => t[0] === 'L')?.[1]).toBe(LIFETIME_LABEL_NAMESPACE);
    const lTag = e.tags.find((t) => t[0] === 'l');
    expect(lTag?.[1]).toBe(LIFETIME_LABEL_VALUE);
    expect(lTag?.[2]).toBe(LIFETIME_LABEL_NAMESPACE);
    expect(e.tags.find((t) => t[0] === 'p')?.[1]).toBe('b'.repeat(64));
  });

  it('records paid_at as a string tag so relay filters can match on it', async () => {
    const e = await buildLifetimeLabel(signer, { memberPubkey: 'a'.repeat(64), paidAt: 1_700_000_000 });
    expect(e.tags.find((t) => t[0] === 'paid_at')?.[1]).toBe('1700000000');
    expect(e.created_at).toBe(1_700_000_000);
  });

  it('omits the invoice_id tag when not provided', async () => {
    const e = await buildLifetimeLabel(signer, { memberPubkey: 'a'.repeat(64), paidAt: 1 });
    expect(e.tags.find((t) => t[0] === 'invoice_id')).toBeUndefined();
  });

  it('includes invoice_id when provided, for cross-referencing with BTCPay', async () => {
    const e = await buildLifetimeLabel(signer, {
      memberPubkey: 'a'.repeat(64),
      paidAt: 1,
      invoiceId: 'INV_XYZ',
    });
    expect(e.tags.find((t) => t[0] === 'invoice_id')?.[1]).toBe('INV_XYZ');
  });
});
