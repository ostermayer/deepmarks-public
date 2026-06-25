// NIP-46 (nostr connect) wire protocol helpers.
//
// Messages are kind:24133 events:
//   - `p` tag points at the *destination* pubkey (bunker for a request,
//     client for a response)
//   - `content` is NIP-44-encrypted between the sender and destination
//   - plaintext is a JSON-RPC-ish object with id + method+params or result
//
// We implement three methods: connect (accepted if the client pubkey is
// in our allowlist), get_public_key (returns the identity pubkey), and
// sign_event (permission-checked, then finalized + returned).
//
// No stateful sessions — every request re-authorizes against the static
// allowlist. A "connect" ACK is courtesy for well-behaved clients like
// NDK's NConnectSigner.

import { nip44, type EventTemplate, type Event as NostrEvent } from 'nostr-tools';

/** NIP-46 request frame, decrypted. */
export interface Nip46Request {
  id: string;
  method: 'connect' | 'get_public_key' | 'sign_event' | 'ping' | string;
  params: string[];
}

/** NIP-46 response frame, pre-encryption. */
export interface Nip46Response {
  id: string;
  result?: string;
  error?: string;
}

/** NIP-46 kind. Do not hard-code in callers. */
export const NIP46_KIND = 24133;

/** Derive the NIP-44 conversation key once per peer to avoid the hash
 *  cost on every message. Callers cache per destination-pubkey. */
export function deriveKey(secret: Uint8Array, peerPubkey: string): Uint8Array {
  return nip44.v2.utils.getConversationKey(secret, peerPubkey);
}

export function encryptPayload(conversationKey: Uint8Array, plaintext: string): string {
  return nip44.v2.encrypt(plaintext, conversationKey);
}

export function decryptPayload(conversationKey: Uint8Array, ciphertext: string): string {
  return nip44.v2.decrypt(ciphertext, conversationKey);
}

/** Parse a decrypted payload. Throws if it isn't a well-shaped request. */
export function parseRequest(plaintext: string): Nip46Request {
  const obj = JSON.parse(plaintext);
  if (!obj || typeof obj !== 'object') throw new Error('payload is not an object');
  if (typeof obj.id !== 'string' || obj.id.length === 0) throw new Error('missing id');
  if (typeof obj.method !== 'string' || obj.method.length === 0) throw new Error('missing method');
  if (!Array.isArray(obj.params)) throw new Error('params must be an array');
  for (const p of obj.params) {
    if (typeof p !== 'string') throw new Error('params must be strings');
  }
  return { id: obj.id, method: obj.method, params: obj.params };
}

export function buildResult(id: string, result: string): Nip46Response {
  return { id, result };
}

export function buildError(id: string, error: string): Nip46Response {
  return { id, error };
}

export function encodeResponse(r: Nip46Response): string {
  return JSON.stringify(r);
}

/** Parse the `event` param of a sign_event request into a template we
 *  can hand to vault.sign(). We deliberately accept only the four fields
 *  (+ optional id/sig/pubkey which we ignore — finalizeEvent overwrites
 *  them with the signed result). */
export function parseSignEventParam(rawEventJson: string): EventTemplate {
  const obj = JSON.parse(rawEventJson);
  if (!obj || typeof obj !== 'object') throw new Error('event is not an object');
  if (typeof obj.kind !== 'number' || !Number.isInteger(obj.kind) || obj.kind < 0 || obj.kind > 65535) {
    throw new Error('event.kind must be an integer in [0, 65535]');
  }
  if (typeof obj.content !== 'string') throw new Error('event.content is required');
  if (!Array.isArray(obj.tags)) throw new Error('event.tags must be an array');
  // Validate tag shape — each entry must be string[]. Without this a
  // payment-proxy bug (or a compromised proxy) could ask the bunker
  // to sign a structurally-broken event that finalizeEvent then turns
  // into a non-canonical id, or which downstream consumers misparse.
  for (const tag of obj.tags as unknown[]) {
    if (!Array.isArray(tag)) throw new Error('event.tags entries must be arrays');
    for (const cell of tag) if (typeof cell !== 'string') throw new Error('event.tags cells must be strings');
  }
  const now = Math.floor(Date.now() / 1000);
  let created_at: number;
  if (typeof obj.created_at === 'number') {
    if (!Number.isInteger(obj.created_at) || obj.created_at <= 0) {
      throw new Error('event.created_at must be a positive integer');
    }
    // Bound future-skew to 10 minutes. A compromised payment-proxy
    // could otherwise ask us to sign an event dated 2099 that would
    // sort first forever on relays ordering by created_at, drowning
    // legitimate events even after we rotate the signing key.
    if (obj.created_at > now + 10 * 60) {
      throw new Error('event.created_at must not be more than 10 minutes in the future');
    }
    created_at = obj.created_at;
  } else {
    created_at = now;
  }
  return {
    kind: obj.kind,
    content: obj.content,
    tags: obj.tags as string[][],
    created_at,
  };
}

/** Serialize a signed event into the `result` string. Clients parse this
 *  back into an Event via JSON.parse. */
export function serializeSignedEvent(ev: NostrEvent): string {
  return JSON.stringify({
    id: ev.id,
    pubkey: ev.pubkey,
    created_at: ev.created_at,
    kind: ev.kind,
    tags: ev.tags,
    content: ev.content,
    sig: ev.sig,
  });
}
