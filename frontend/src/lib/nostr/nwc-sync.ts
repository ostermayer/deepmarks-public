import { getNdk } from './ndk.js';
import { publishEvent } from './publish.js';
import { canonicalRelaySet } from './canonical-relay-set.js';
import type { NwcConnection } from './nwc-store.js';

export const KIND_NWC_SET = 30003;
export const NWC_SET_NAME = 'deepmarks-nwc';

interface SyncedNwcPayload {
  schemaVersion: 1;
  updatedAt: number;
  deletedAt?: number;
  connection?: NwcConnection;
}

export async function fetchSyncedNwc(ownPubkey: string): Promise<SyncedNwcPayload | null> {
  const ndk = getNdk();
  if (!ndk.signer) return null;
  const relaySet = canonicalRelaySet();
  const event = await ndk.fetchEvent(
    {
      kinds: [KIND_NWC_SET],
      authors: [ownPubkey],
      '#d': [NWC_SET_NAME],
    },
    relaySet ? { groupable: false } : undefined,
    relaySet ?? undefined,
  );
  if (!event || event.pubkey !== ownPubkey) return null;
  const me = ndk.getUser({ pubkey: ownPubkey });
  const plaintext = await ndk.signer.decrypt(me, event.content, 'nip44');
  return normalizePayload(JSON.parse(plaintext));
}

export async function publishSyncedNwc(
  connection: NwcConnection | null,
  ownPubkey: string,
): Promise<void> {
  const ndk = getNdk();
  if (!ndk.signer) throw new Error('No signer attached. Sign in first.');
  const me = ndk.getUser({ pubkey: ownPubkey });
  const now = Math.floor(Date.now() / 1000);
  const payload: SyncedNwcPayload = connection
    ? { schemaVersion: 1, updatedAt: now, connection }
    : { schemaVersion: 1, updatedAt: now, deletedAt: now };
  const content = await ndk.signer.encrypt(me, JSON.stringify(payload), 'nip44');
  await publishEvent({
    kind: KIND_NWC_SET,
    created_at: now,
    tags: [['d', NWC_SET_NAME]],
    content,
  }, ownPubkey);
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
