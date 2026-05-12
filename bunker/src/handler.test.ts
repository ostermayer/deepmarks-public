import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
  verifyEvent,
  type Event as NostrEvent,
} from 'nostr-tools';
import { AuditLog } from './audit.js';
import { handleRequest } from './handler.js';
import {
  NIP46_KIND,
  deriveKey,
  decryptPayload,
  encryptPayload,
} from './nip46.js';
import { Vault } from './vault.js';

// ── Fixtures ──────────────────────────────────────────────────────────

interface Fixture {
  vault: Vault;
  audit: AuditLog;
  auditPath: string;
  authorizedClient: string;
  clientSk: Uint8Array;
  brandSk: Uint8Array;
  brandPub: string;
  personalPub: string;
}

function makeFixture(): Fixture {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bunker-handler-'));
  const brandSk = generateSecretKey();
  const personalSk = generateSecretKey();
  const brandPath = path.join(tmp, 'brand.nsec');
  const personalPath = path.join(tmp, 'personal.nsec');
  fs.writeFileSync(brandPath, nip19.nsecEncode(brandSk), { mode: 0o400 });
  fs.writeFileSync(personalPath, nip19.nsecEncode(personalSk), { mode: 0o400 });

  const vault = Vault.load([
    { identity: 'brand', path: brandPath },
    { identity: 'personal', path: personalPath },
  ]);

  const auditPath = path.join(tmp, 'audit.jsonl');
  const audit = new AuditLog(auditPath);

  const clientSk = generateSecretKey();

  return {
    vault,
    audit,
    auditPath,
    authorizedClient: getPublicKey(clientSk),
    clientSk,
    brandSk,
    brandPub: vault.pubkeyFor('brand'),
    personalPub: vault.pubkeyFor('personal'),
  };
}

function buildClientRequest(
  f: Fixture,
  targetIdentityPubkey: string,
  plaintextPayload: string,
): NostrEvent {
  const convKey = deriveKey(f.clientSk, targetIdentityPubkey);
  const cipher = encryptPayload(convKey, plaintextPayload);
  return finalizeEvent(
    {
      kind: NIP46_KIND,
      content: cipher,
      tags: [['p', targetIdentityPubkey]],
      created_at: Math.floor(Date.now() / 1000),
    },
    f.clientSk,
  );
}

function decryptResponse(
  f: Fixture,
  targetIdentityPubkey: string,
  responseEvent: NostrEvent,
): unknown {
  const convKey = deriveKey(f.clientSk, targetIdentityPubkey);
  const plaintext = decryptPayload(convKey, responseEvent.content);
  return JSON.parse(plaintext);
}

function readAudit(f: Fixture): Array<Record<string, unknown>> {
  if (!fs.existsSync(f.auditPath)) return [];
  return fs
    .readFileSync(f.auditPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('handleRequest — method: connect', () => {
  let f: Fixture;
  beforeEach(() => {
    f = makeFixture();
  });

  it('ACKs an authorized client', async () => {
    const req = buildClientRequest(
      f,
      f.brandPub,
      JSON.stringify({ id: 'r1', method: 'connect', params: [f.brandPub] }),
    );
    const resp = await handleRequest(
      { vault: f.vault, audit: f.audit, authorizedClient: f.authorizedClient },
      req,
    );
    expect(resp).not.toBeNull();
    const decoded = decryptResponse(f, f.brandPub, resp!) as {
      id: string;
      result?: string;
      error?: string;
    };
    expect(decoded).toEqual({ id: 'r1', result: 'ack' });
    expect(readAudit(f)[0]!.outcome).toBe('accepted');
  });

  it('rejects an unauthorized client silently (no response, audited)', async () => {
    // Stranger crafts a well-formed connect request encrypted to the
    // brand pubkey. Pre-2026-04-25 we'd derive a NIP-44 key, decrypt,
    // build + sign an error response. That's a CPU DoS surface — strfry
    // accepts kind:24133 from any internet pubkey, so an attacker can
    // flood us into doing scalar-mult per event using the brand secret.
    // New behavior: drop on the floor at the pubkey gate, audit it,
    // never decrypt and never respond.
    const strangerSk = generateSecretKey();
    const convKey = deriveKey(strangerSk, f.brandPub);
    const cipher = encryptPayload(
      convKey,
      JSON.stringify({ id: 'r1', method: 'connect', params: [f.brandPub] }),
    );
    const ev = finalizeEvent(
      {
        kind: NIP46_KIND,
        content: cipher,
        tags: [['p', f.brandPub]],
        created_at: Math.floor(Date.now() / 1000),
      },
      strangerSk,
    );
    const resp = await handleRequest(
      { vault: f.vault, audit: f.audit, authorizedClient: f.authorizedClient },
      ev,
    );
    expect(resp).toBeNull();
    const audit = readAudit(f)[0]!;
    expect(audit.outcome).toBe('rejected');
    expect(audit.reason).toBe('unauthorized client pubkey');
    expect(audit.clientPubkey).toBe(getPublicKey(strangerSk));
  });
});

describe('handleRequest — method: sign_event', () => {
  let f: Fixture;
  beforeEach(() => {
    f = makeFixture();
  });

  it('signs a kind:9735 zap receipt with the brand identity', async () => {
    const template = {
      kind: 9735,
      content: '',
      tags: [['p', 'f'.repeat(64)]],
      created_at: 1_700_000_000,
    };
    const req = buildClientRequest(
      f,
      f.brandPub,
      JSON.stringify({
        id: 's1',
        method: 'sign_event',
        params: [JSON.stringify(template)],
      }),
    );
    const resp = await handleRequest(
      { vault: f.vault, audit: f.audit, authorizedClient: f.authorizedClient },
      req,
    );
    expect(resp).not.toBeNull();
    expect(resp!.kind).toBe(NIP46_KIND);
    // Response event itself is signed by the brand identity.
    expect(resp!.pubkey).toBe(f.brandPub);
    expect(verifyEvent(resp!)).toBe(true);

    const decoded = decryptResponse(f, f.brandPub, resp!) as {
      id: string;
      result?: string;
      error?: string;
    };
    expect(decoded.id).toBe('s1');
    expect(decoded.error).toBeUndefined();
    const signed = JSON.parse(decoded.result!);
    expect(signed.kind).toBe(9735);
    expect(signed.pubkey).toBe(f.brandPub);
    expect(verifyEvent(signed)).toBe(true);

    const audit = readAudit(f);
    expect(audit[0]).toMatchObject({
      outcome: 'accepted',
      identity: 'brand',
      kind: 9735,
    });
    expect(audit[0]!.eventId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('signs a kind:1985 lifetime label with the brand identity', async () => {
    const template = {
      kind: 1985,
      content: 'Deepmarks lifetime',
      tags: [
        ['L', 'org.deepmarks.tier'],
        ['l', 'lifetime', 'org.deepmarks.tier'],
      ],
      created_at: 1_700_000_000,
    };
    const req = buildClientRequest(
      f,
      f.brandPub,
      JSON.stringify({
        id: 's2',
        method: 'sign_event',
        params: [JSON.stringify(template)],
      }),
    );
    const resp = await handleRequest(
      { vault: f.vault, audit: f.audit, authorizedClient: f.authorizedClient },
      req,
    );
    expect(resp).not.toBeNull();
    const decoded = decryptResponse(f, f.brandPub, resp!) as { result?: string };
    const signed = JSON.parse(decoded.result!);
    expect(signed.kind).toBe(1985);
    expect(signed.pubkey).toBe(f.brandPub);
  });

  it('rejects kind:1 (note) for brand identity — bunker core guarantee', async () => {
    const template = {
      kind: 1,
      content: 'not a note the server should sign',
      tags: [],
      created_at: 1_700_000_000,
    };
    const req = buildClientRequest(
      f,
      f.brandPub,
      JSON.stringify({
        id: 's3',
        method: 'sign_event',
        params: [JSON.stringify(template)],
      }),
    );
    const resp = await handleRequest(
      { vault: f.vault, audit: f.audit, authorizedClient: f.authorizedClient },
      req,
    );
    expect(resp).not.toBeNull();
    const decoded = decryptResponse(f, f.brandPub, resp!) as {
      error?: string;
    };
    expect(decoded.error).toMatch(/kind 1 not allowed/);
    expect(readAudit(f)[0]!.outcome).toBe('rejected');
  });

  it('rejects kind:1985 for personal identity — only brand can sign labels', async () => {
    const template = {
      kind: 1985,
      content: '',
      tags: [],
      created_at: 1_700_000_000,
    };
    const req = buildClientRequest(
      f,
      f.personalPub,
      JSON.stringify({
        id: 's4',
        method: 'sign_event',
        params: [JSON.stringify(template)],
      }),
    );
    const resp = await handleRequest(
      { vault: f.vault, audit: f.audit, authorizedClient: f.authorizedClient },
      req,
    );
    const decoded = decryptResponse(f, f.personalPub, resp!) as { error?: string };
    expect(decoded.error).toMatch(/kind 1985 not allowed for personal/);
  });

  it('returns null (no response) for events not addressed to one of our identities', async () => {
    const unknownPubkey = getPublicKey(generateSecretKey());
    const convKey = deriveKey(f.clientSk, unknownPubkey);
    const cipher = encryptPayload(convKey, JSON.stringify({ id: 'x', method: 'ping', params: [] }));
    const ev = finalizeEvent(
      {
        kind: NIP46_KIND,
        content: cipher,
        tags: [['p', unknownPubkey]],
        created_at: Math.floor(Date.now() / 1000),
      },
      f.clientSk,
    );
    const resp = await handleRequest(
      { vault: f.vault, audit: f.audit, authorizedClient: f.authorizedClient },
      ev,
    );
    expect(resp).toBeNull();
  });

  it('does not respond to events with undecryptable content (no oracle for crypto errors)', async () => {
    // Build an event addressed to brand but with garbage content.
    const ev = finalizeEvent(
      {
        kind: NIP46_KIND,
        content: 'not-valid-nip44-ciphertext',
        tags: [['p', f.brandPub]],
        created_at: Math.floor(Date.now() / 1000),
      },
      f.clientSk,
    );
    const resp = await handleRequest(
      { vault: f.vault, audit: f.audit, authorizedClient: f.authorizedClient },
      ev,
    );
    expect(resp).toBeNull();
    const audit = readAudit(f);
    expect(audit[0]!.outcome).toBe('errored');
  });
});

describe('handleRequest — method: get_public_key', () => {
  it('returns the brand pubkey when addressed to brand', async () => {
    const f = makeFixture();
    const req = buildClientRequest(
      f,
      f.brandPub,
      JSON.stringify({ id: 'gp', method: 'get_public_key', params: [] }),
    );
    const resp = await handleRequest(
      { vault: f.vault, audit: f.audit, authorizedClient: f.authorizedClient },
      req,
    );
    const decoded = decryptResponse(f, f.brandPub, resp!) as { result?: string };
    expect(decoded.result).toBe(f.brandPub);
  });
});
