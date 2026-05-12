import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import {
  NIP46_KIND,
  buildError,
  buildResult,
  decryptPayload,
  deriveKey,
  encryptPayload,
  encodeResponse,
  parseRequest,
  parseSignEventParam,
  serializeSignedEvent,
} from './nip46.js';

describe('NIP46_KIND', () => {
  it('is 24133 per spec', () => {
    expect(NIP46_KIND).toBe(24133);
  });
});

describe('encryptPayload + decryptPayload round-trip', () => {
  it('works symmetrically with matching conversation keys', () => {
    const aSk = generateSecretKey();
    const bSk = generateSecretKey();
    const aPub = getPublicKey(aSk);
    const bPub = getPublicKey(bSk);

    // A encrypts for B using (aSk, bPub).
    const aToB = deriveKey(aSk, bPub);
    // B decrypts from A using (bSk, aPub). NIP-44 conversation key is
    // symmetric under swap, so these should produce the same key bytes.
    const bFromA = deriveKey(bSk, aPub);
    expect(aToB).toEqual(bFromA);

    const plain = JSON.stringify({ id: '1', method: 'sign_event', params: [] });
    const cipher = encryptPayload(aToB, plain);
    expect(decryptPayload(bFromA, cipher)).toBe(plain);
  });
});

describe('parseRequest', () => {
  it('returns id + method + params on a valid payload', () => {
    const req = parseRequest(JSON.stringify({ id: 'abc', method: 'ping', params: [] }));
    expect(req).toEqual({ id: 'abc', method: 'ping', params: [] });
  });

  it('accepts string params', () => {
    const req = parseRequest(
      JSON.stringify({ id: '1', method: 'sign_event', params: ['{}'] }),
    );
    expect(req.params).toEqual(['{}']);
  });

  it('rejects missing id', () => {
    expect(() => parseRequest(JSON.stringify({ method: 'x', params: [] }))).toThrow(/id/);
  });

  it('rejects missing method', () => {
    expect(() => parseRequest(JSON.stringify({ id: '1', params: [] }))).toThrow(/method/);
  });

  it('rejects non-array params', () => {
    expect(() =>
      parseRequest(JSON.stringify({ id: '1', method: 'x', params: 'oops' })),
    ).toThrow(/array/);
  });

  it('rejects non-string param entries', () => {
    expect(() =>
      parseRequest(JSON.stringify({ id: '1', method: 'x', params: [42] })),
    ).toThrow(/strings/);
  });

  it('rejects non-JSON input', () => {
    expect(() => parseRequest('<garbage>')).toThrow();
  });
});

describe('buildResult / buildError / encodeResponse', () => {
  it('shapes a success response', () => {
    const r = buildResult('1', 'ok');
    expect(encodeResponse(r)).toBe('{"id":"1","result":"ok"}');
  });

  it('shapes an error response', () => {
    const r = buildError('1', 'nope');
    expect(encodeResponse(r)).toBe('{"id":"1","error":"nope"}');
  });
});

describe('parseSignEventParam', () => {
  it('extracts kind, content, tags, created_at', () => {
    const template = parseSignEventParam(
      JSON.stringify({
        kind: 9735,
        content: 'hi',
        tags: [['p', 'f'.repeat(64)]],
        created_at: 1_700_000_000,
      }),
    );
    expect(template.kind).toBe(9735);
    expect(template.content).toBe('hi');
    expect(template.tags).toEqual([['p', 'f'.repeat(64)]]);
    expect(template.created_at).toBe(1_700_000_000);
  });

  it('fills in created_at from current time if missing', () => {
    const before = Math.floor(Date.now() / 1000);
    const template = parseSignEventParam(
      JSON.stringify({ kind: 1, content: '', tags: [] }),
    );
    const after = Math.floor(Date.now() / 1000);
    expect(template.created_at).toBeGreaterThanOrEqual(before);
    expect(template.created_at).toBeLessThanOrEqual(after + 1);
  });

  it('ignores id/sig/pubkey on the input (finalize overwrites them)', () => {
    const template = parseSignEventParam(
      JSON.stringify({
        kind: 1,
        content: '',
        tags: [],
        // Real timestamp — created_at:0 (epoch) is now rejected as a
        // bounded-future-skew side effect of the security hardening.
        created_at: Math.floor(Date.now() / 1000),
        id: 'deadbeef',
        sig: 'deadbeef',
        pubkey: 'deadbeef',
      }),
    );
    // Shape of EventTemplate doesn't include those fields.
    expect(Object.keys(template).sort()).toEqual(['content', 'created_at', 'kind', 'tags']);
  });

  it('rejects missing kind', () => {
    expect(() =>
      parseSignEventParam(JSON.stringify({ content: '', tags: [] })),
    ).toThrow(/kind/);
  });

  it('rejects non-array tags', () => {
    expect(() =>
      parseSignEventParam(JSON.stringify({ kind: 1, content: '', tags: 'x' })),
    ).toThrow(/tags/);
  });
});

describe('serializeSignedEvent', () => {
  it('emits a JSON string with every required field', () => {
    const serialized = serializeSignedEvent({
      id: 'a'.repeat(64),
      pubkey: 'b'.repeat(64),
      created_at: 1,
      kind: 9735,
      tags: [],
      content: '',
      sig: 'c'.repeat(128),
    });
    const parsed = JSON.parse(serialized);
    expect(parsed).toEqual({
      id: 'a'.repeat(64),
      pubkey: 'b'.repeat(64),
      created_at: 1,
      kind: 9735,
      tags: [],
      content: '',
      sig: 'c'.repeat(128),
    });
  });
});
