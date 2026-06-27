import { discoverUserRelays } from './nostr.js';
import {
  getSettings,
  importNip65Relays,
  pushSettingsToServer,
  syncSettingsFromServer,
  type Settings,
} from './settings-store.js';

/**
 * Sync account settings, then replace extension relays with the user's
 * current published NIP-65 relay list. This keeps old event-seen relays
 * from lingering in existing installs while still preserving the
 * Deepmarks relay added by importNip65Relays.
 */
export async function syncSettingsAndPublishedRelays(pubkey: string | null, nsecHex: string): Promise<Settings> {
  const synced = await syncSettingsFromServer(nsecHex).catch(() => getSettings());
  if (!pubkey) return synced;

  const discovered = await discoverUserRelays(pubkey).catch(() => []);
  if (discovered.length === 0) return synced;

  const settings = await importNip65Relays(discovered);
  return pushSettingsToServer(nsecHex, settings).catch(() => settings);
}
