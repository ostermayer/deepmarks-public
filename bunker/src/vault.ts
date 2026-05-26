// Nsec storage + signing. The only place in the code that holds raw
// private keys. Loaded once at boot from chmod-400 files owned by the
// bunker user; the raw bytes never leave this module.

import fs from 'node:fs';
import { finalizeEvent, getPublicKey, nip19, type EventTemplate, type Event as NostrEvent } from 'nostr-tools';
import type { IdentityName } from './permissions.js';

export interface VaultEntry {
  readonly identity: IdentityName;
  /** Hex-encoded x-only pubkey — safe to log. */
  readonly pubkey: string;
}

/**
 * Holds nsec bytes for one or more identities. `sign` takes an unsigned
 * event template + identity name and returns a signed event. The raw
 * private key is never returned from any method.
 */
export class Vault {
  private readonly keys: Map<IdentityName, Uint8Array>;
  private readonly pubkeys: Map<IdentityName, string>;

  private constructor(
    keys: Map<IdentityName, Uint8Array>,
    pubkeys: Map<IdentityName, string>,
  ) {
    this.keys = keys;
    this.pubkeys = pubkeys;
  }

  /** Load identities from the given file paths. Validates that each file
   *  is readable + parseable as bech32 nsec or 64-char hex. */
  static load(entries: Array<{ identity: IdentityName; path: string }>): Vault {
    const keys = new Map<IdentityName, Uint8Array>();
    const pubkeys = new Map<IdentityName, string>();
    for (const { identity, path } of entries) {
      const raw = fs.readFileSync(path, 'utf8').trim();
      const bytes = parseNsec(raw);
      const pubkey = getPublicKey(bytes);
      keys.set(identity, bytes);
      pubkeys.set(identity, pubkey);
    }
    return new Vault(keys, pubkeys);
  }

  pubkeyFor(identity: IdentityName): string {
    const p = this.pubkeys.get(identity);
    if (!p) throw new Error(`identity not loaded: ${identity}`);
    return p;
  }

  entries(): VaultEntry[] {
    return Array.from(this.pubkeys.entries()).map(([identity, pubkey]) => ({ identity, pubkey }));
  }

  /** Finalize (hash + sign) an unsigned event template as the given identity. */
  sign(identity: IdentityName, template: EventTemplate): NostrEvent {
    const key = this.keys.get(identity);
    if (!key) throw new Error(`identity not loaded: ${identity}`);
    return finalizeEvent(template, key);
  }

  /** Return the raw secret for use with nip44.encrypt/decrypt. Keep this
   *  API on the vault so no caller ever handles the key via the kv map
   *  directly. Returns a copy — without it, any caller that .fill(0)s
   *  the returned bytes (e.g. for "wipe after use" hygiene) would
   *  silently zero the vault's own backing buffer and brick subsequent
   *  signs with no error trail. */
  secretFor(identity: IdentityName): Uint8Array {
    const k = this.keys.get(identity);
    if (!k) throw new Error(`identity not loaded: ${identity}`);
    return new Uint8Array(k);
  }
}

/** Parse bech32 nsec1… or 64-char lowercase hex into 32 bytes. */
export function parseNsec(raw: string): Uint8Array {
  const trimmed = raw.trim();
  if (trimmed.startsWith('nsec1')) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== 'nsec') {
      throw new Error(`expected nsec, got ${decoded.type}`);
    }
    return decoded.data;
  }
  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      out[i] = Number.parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  throw new Error('nsec must be bech32 (nsec1…) or 64-char hex');
}
