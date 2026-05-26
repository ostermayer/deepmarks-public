import { finalizeEvent, nip44, type Event as NostrEvent } from 'nostr-tools';
import { hexToBytes } from 'nostr-tools/utils';
import { getReadRelays } from './settings-store.js';
import { postSignedEvent, sharedPool } from './nostr.js';
import type { NwcConnection } from './nwc-store.js';

export const KIND_NWC_SET = 30003;
export const NWC_SET_NAME = 'deepmarks-nwc';

interface SyncedNwcPayload {
  schemaVersion: 1;
  updatedAt: number;
  deletedAt?: number;
  connection?: NwcConnection;
}

function conversationKey(nsecHex: string, ownPubkey: string): Uint8Array {
  return nip44.v2.utils.getConversationKey(hexToBytes(nsecHex), ownPubkey);
}

export async function fetchSyncedNwc(
  nsecHex: string,
  ownPubkey: string,
): Promise<SyncedNwcPayload | null> {
  const relays = await getReadRelays();
  const events = await sharedPool().querySync(
    relays,
    {
      kinds: [KIND_NWC_SET],
      authors: [ownPubkey],
      '#d': [NWC_SET_NAME],
      limit: 1,
    },
    { maxWait: 4000 },
  ).catch(() => [] as NostrEvent[]);
  const latest = events
    .filter((event) => event.pubkey === ownPubkey)
    .sort((a, b) => b.created_at - a.created_at)[0];
  if (!latest) return null;
  const plaintext = nip44.v2.decrypt(latest.content, conversationKey(nsecHex, ownPubkey));
  return normalizePayload(JSON.parse(plaintext));
}

export async function publishSyncedNwc(
  connection: NwcConnection | null,
  nsecHex: string,
  ownPubkey: string,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const payload: SyncedNwcPayload = connection
    ? { schemaVersion: 1, updatedAt: now, connection }
    : { schemaVersion: 1, updatedAt: now, deletedAt: now };
  const content = nip44.v2.encrypt(JSON.stringify(payload), conversationKey(nsecHex, ownPubkey));
  const event = finalizeEvent(
    {
      kind: KIND_NWC_SET,
      created_at: now,
      tags: [['d', NWC_SET_NAME]],
      content,
    },
    hexToBytes(nsecHex),
  );
  await postSignedEvent(event, nsecHex);
}

function normalizePayload(raw: unknown): SyncedNwcPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<SyncedNwcPayload>;
  const updatedAt = typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
    ? Math.floor(value.updatedAt)
    : 0;
  if (value.deletedAt !== undefined) {
    const deletedAt = typeof value.deletedAt === 'number' && Number.isFinite(value.deletedAt)
      ? Math.floor(value.deletedAt)
      : updatedAt;
    return { schemaVersion: 1, updatedAt, deletedAt };
  }
  if (!isNwcConnection(value.connection)) return null;
  return {
    schemaVersion: 1,
    updatedAt,
    connection: {
      ...value.connection,
      appSecret: value.connection.appSecret.toLowerCase(),
      walletPubkey: value.connection.walletPubkey.toLowerCase(),
    },
  };
}

function isNwcConnection(value: unknown): value is NwcConnection {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<NwcConnection>;
  return (
    typeof v.walletPubkey === 'string' &&
    /^[0-9a-f]{64}$/i.test(v.walletPubkey) &&
    typeof v.relayUrl === 'string' &&
    /^wss?:\/\//i.test(v.relayUrl) &&
    typeof v.appSecret === 'string' &&
    /^[0-9a-f]{64}$/i.test(v.appSecret) &&
    typeof v.connectedAt === 'number'
  );
}
