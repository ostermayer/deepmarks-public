import { describe, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

const decodeMock = vi.hoisted(() => vi.fn());

vi.mock('light-bolt11-decoder', () => ({
  decode: decodeMock,
}));

import { classifyZapInvoiceBinding, verifyZapInvoice, zapRequestDescriptionHashes } from './zap.js';

const rawZap = JSON.stringify({ kind: 9734, content: '', tags: [['amount', '21000']] });
const descHash = bytesToHex(sha256(new TextEncoder().encode(rawZap)));

function decoded(amount = '21000', descriptionHash = descHash) {
  return {
    sections: [
      { name: 'amount', value: amount },
      { name: 'description_hash', value: descriptionHash },
    ],
  };
}

describe('verifyZapInvoice', () => {
  it('accepts an invoice with the requested amount and zap request hash', () => {
    decodeMock.mockReturnValueOnce(decoded());

    expect(() => verifyZapInvoice('lnbc...', 21_000, rawZap, 'alice')).not.toThrow();
  });

  it('rejects invoices for a different amount', () => {
    decodeMock.mockReturnValueOnce(decoded('22000'));

    expect(() => verifyZapInvoice('lnbc...', 21_000, rawZap, 'alice'))
      .toThrow(/amount mismatch/);
  });

  it('rejects invoices that are not bound to the signed zap request', () => {
    decodeMock.mockReturnValueOnce(decoded('21000', '0'.repeat(64)));

    expect(() => verifyZapInvoice('lnbc...', 21_000, rawZap, 'alice'))
      .toThrow(/description hash/);
  });

  it('classifies unbound invoices as payable but not receipt-verifiable', () => {
    decodeMock.mockReturnValueOnce(decoded('21000', '0'.repeat(64)));

    expect(classifyZapInvoiceBinding('lnbc...', 21_000, rawZap, 'alice')).toEqual({
      verifiable: false,
      warning: expect.stringContaining('not bound to the signed zap request'),
    });
  });

  it('keeps amount mismatch as a hard failure', () => {
    decodeMock.mockReturnValueOnce(decoded('22000', '0'.repeat(64)));

    expect(() => classifyZapInvoiceBinding('lnbc...', 21_000, rawZap, 'alice'))
      .toThrow(/amount mismatch/);
  });

  it('accepts provider-side canonical ordering of the same signed zap request', () => {
    const signed = {
      kind: 9734,
      pubkey: 'a'.repeat(64),
      created_at: 1,
      tags: [['amount', '21000']],
      content: '',
      id: 'b'.repeat(64),
      sig: 'c'.repeat(128),
    };
    const raw = JSON.stringify(signed);
    const canonical = JSON.stringify({
      id: signed.id,
      pubkey: signed.pubkey,
      created_at: signed.created_at,
      kind: signed.kind,
      tags: signed.tags,
      content: signed.content,
      sig: signed.sig,
    });
    const canonicalHash = bytesToHex(sha256(new TextEncoder().encode(canonical)));
    decodeMock.mockReturnValueOnce(decoded('21000', canonicalHash));

    expect(zapRequestDescriptionHashes(raw).has(canonicalHash)).toBe(true);
    expect(() => verifyZapInvoice('lnbc...', 21_000, raw, 'alice')).not.toThrow();
  });
});
