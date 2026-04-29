import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  btcPayConfigFromEnv,
  buildInvoiceBody,
  verifyWebhookSignature,
} from './btcpay.js';

describe('btcPayConfigFromEnv', () => {
  it('returns null when any required var is missing', () => {
    expect(btcPayConfigFromEnv({})).toBeNull();
    expect(
      btcPayConfigFromEnv({
        BTCPAY_URL: 'https://x',
        BTCPAY_STORE_ID: 's',
        BTCPAY_API_KEY: 'k',
      }),
    ).toBeNull();
  });

  it('strips trailing slashes from the URL', () => {
    const cfg = btcPayConfigFromEnv({
      BTCPAY_URL: 'https://btcpay.example.com///',
      BTCPAY_STORE_ID: 'store',
      BTCPAY_API_KEY: 'key',
      BTCPAY_WEBHOOK_SECRET: 'secret',
    });
    expect(cfg?.url).toBe('https://btcpay.example.com');
  });
});

describe('buildInvoiceBody', () => {
  it('encodes the amount as a string in SATS currency', () => {
    const body = buildInvoiceBody({ pubkey: 'a'.repeat(64), amountSats: 21000 });
    expect(body.amount).toBe('21000');
    expect(body.currency).toBe('SATS');
  });

  it('embeds the buyer pubkey in metadata so the webhook can recover it', () => {
    const body = buildInvoiceBody({ pubkey: 'b'.repeat(64), amountSats: 500 });
    const meta = body.metadata as Record<string, unknown>;
    expect(meta.deepmarksPubkey).toBe('b'.repeat(64));
    expect(meta.deepmarksProduct).toBe('lifetime');
  });

  it('forwards an optional redirectUrl', () => {
    const body = buildInvoiceBody({
      pubkey: 'a'.repeat(64),
      amountSats: 100,
      redirectUrl: 'https://deepmarks.org/app/upgrade/done',
    });
    const checkout = body.checkout as Record<string, unknown>;
    expect(checkout.redirectURL).toBe('https://deepmarks.org/app/upgrade/done');
  });
});

describe('verifyWebhookSignature', () => {
  const secret = 'test-secret-value';
  const payload = JSON.stringify({ type: 'InvoiceSettled', invoiceId: 'x' });
  const validSig =
    'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');

  it('accepts a matching signature', () => {
    expect(verifyWebhookSignature(payload, validSig, secret)).toBe(true);
  });

  it('rejects when the signature header is missing', () => {
    expect(verifyWebhookSignature(payload, undefined, secret)).toBe(false);
  });

  it('rejects when the header does not start with sha256=', () => {
    expect(verifyWebhookSignature(payload, 'md5=abc', secret)).toBe(false);
    expect(verifyWebhookSignature(payload, 'abc', secret)).toBe(false);
  });

  it('rejects when the secret differs', () => {
    expect(verifyWebhookSignature(payload, validSig, 'wrong-secret')).toBe(false);
  });

  it('rejects when the payload differs', () => {
    expect(verifyWebhookSignature('tampered', validSig, secret)).toBe(false);
  });

  it('rejects non-hex signatures without throwing', () => {
    expect(verifyWebhookSignature(payload, 'sha256=not-hex', secret)).toBe(false);
  });

  it('works against Buffer bodies the same way as strings', () => {
    expect(verifyWebhookSignature(Buffer.from(payload), validSig, secret)).toBe(true);
  });
});
