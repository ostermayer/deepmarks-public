import { describe, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

const decodeMock = vi.hoisted(() => vi.fn());

vi.mock('light-bolt11-decoder', () => ({
  decode: decodeMock,
}));

import { verifyZapInvoice } from './zap.js';

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
});
