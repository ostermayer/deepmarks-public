import type { Redis } from 'ioredis';
import { z } from 'zod';

const SETTINGS_PREFIX = 'dm:user-settings:';

const RelaySchema = z.object({
  url: z.string().trim().max(500).refine((raw) => {
    try {
      const parsed = new URL(raw);
      return (parsed.protocol === 'wss:' || parsed.protocol === 'ws:') &&
        parsed.hostname.includes('.') &&
        parsed.hostname !== 'localhost' &&
        !parsed.hostname.endsWith('.local');
    } catch {
      return false;
    }
  }, 'relay URL must be public ws(s)'),
  read: z.boolean().default(true),
  write: z.boolean().default(true),
});

const BlossomServerSchema = z.string().trim().max(500).refine((raw) => {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' &&
      parsed.hostname.includes('.') &&
      parsed.hostname !== 'localhost' &&
      !parsed.hostname.endsWith('.local');
  } catch {
    return false;
  }
}, 'backup Blossom server must be public https');

export const UserSettingsInputSchema = z.object({
  relays: z.array(RelaySchema).max(20).optional(),
  defaultTags: z.array(z.string().trim().min(1).max(48)).max(40).optional(),
  defaultVisibility: z.enum(['private', 'public']).optional(),
  archiveAllByDefault: z.boolean().optional(),
  archiveDefaultManualOverride: z.boolean().optional(),
  backupBlossomServers: z.array(BlossomServerSchema).max(8).optional(),
});

export interface RelayConfig {
  url: string;
  read: boolean;
  write: boolean;
}

export interface UserSettings {
  schemaVersion: 1;
  updatedAt: number;
  relays: RelayConfig[];
  defaultTags: string[];
  defaultVisibility: 'private' | 'public';
  archiveAllByDefault: boolean;
  archiveDefaultManualOverride: boolean;
  backupBlossomServers: string[];
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  schemaVersion: 1,
  updatedAt: 0,
  relays: [
    { url: 'wss://relay.deepmarks.org', read: true, write: true },
    { url: 'wss://nos.lol', read: true, write: true },
    { url: 'wss://relay.primal.net', read: true, write: true },
  ],
  defaultTags: ['toread'],
  defaultVisibility: 'private',
  archiveAllByDefault: false,
  archiveDefaultManualOverride: false,
  backupBlossomServers: [],
};

export class UserSettingsStore {
  constructor(private readonly redis: Redis) {}

  async get(pubkey: string): Promise<UserSettings> {
    const raw = await this.redis.get(SETTINGS_PREFIX + pubkey);
    if (!raw) return { ...DEFAULT_USER_SETTINGS, relays: cloneRelays(DEFAULT_USER_SETTINGS.relays) };
    try {
      return normalize(JSON.parse(raw) as Partial<UserSettings>);
    } catch {
      return { ...DEFAULT_USER_SETTINGS, relays: cloneRelays(DEFAULT_USER_SETTINGS.relays) };
    }
  }

  async put(pubkey: string, input: z.infer<typeof UserSettingsInputSchema>): Promise<UserSettings> {
    const next = normalize({
      ...input,
      schemaVersion: 1,
      updatedAt: Math.floor(Date.now() / 1000),
    });
    await this.redis.set(SETTINGS_PREFIX + pubkey, JSON.stringify(next));
    return next;
  }

  async delete(pubkey: string): Promise<boolean> {
    return (await this.redis.del(SETTINGS_PREFIX + pubkey)) > 0;
  }
}

function normalize(raw: Partial<UserSettings>): UserSettings {
  return {
    schemaVersion: 1,
    updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)
      ? Math.max(0, Math.floor(raw.updatedAt))
      : 0,
    relays: normalizeRelays(raw.relays),
    defaultTags: normalizeTags(raw.defaultTags),
    defaultVisibility: raw.defaultVisibility === 'public' ? 'public' : 'private',
    archiveAllByDefault: !!raw.archiveAllByDefault,
    archiveDefaultManualOverride: raw.archiveDefaultManualOverride === true,
    backupBlossomServers: normalizeBlossom(raw.backupBlossomServers),
  };
}

function normalizeRelays(raw: unknown): RelayConfig[] {
  const parsed = z.array(RelaySchema).max(20).safeParse(raw);
  if (!parsed.success || parsed.data.length === 0) return cloneRelays(DEFAULT_USER_SETTINGS.relays);
  const seen = new Set<string>();
  const out: RelayConfig[] = [];
  for (const relay of parsed.data) {
    const url = normalizeUrl(relay.url);
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, read: relay.read, write: relay.write });
  }
  return migrateLegacyDefaultRelays(out.length > 0 ? out : cloneRelays(DEFAULT_USER_SETTINGS.relays));
}

function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [...DEFAULT_USER_SETTINGS.defaultTags];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const tag = value.trim().replace(/^#/, '').toLowerCase();
    if (!tag || tag.length > 48 || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

function normalizeBlossom(raw: unknown): string[] {
  const parsed = z.array(BlossomServerSchema).max(8).safeParse(raw);
  if (!parsed.success) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of parsed.data) {
    const origin = new URL(value).origin;
    if (seen.has(origin)) continue;
    seen.add(origin);
    out.push(origin);
  }
  return out;
}

function normalizeUrl(raw: string): string {
  return raw.trim().replace(/\/$/, '');
}

function cloneRelays(relays: RelayConfig[]): RelayConfig[] {
  return relays.map((relay) => ({ ...relay }));
}

const DAMUS_RELAY = 'wss://relay.damus.io';
const LEGACY_DEFAULT_RELAY_URLS = [
  'wss://relay.deepmarks.org',
  DAMUS_RELAY,
  'wss://nos.lol',
  'wss://relay.primal.net',
];

function migrateLegacyDefaultRelays(relays: RelayConfig[]): RelayConfig[] {
  const urls = new Set(relays.map((relay) => relay.url));
  const isLegacyDefault =
    relays.length === LEGACY_DEFAULT_RELAY_URLS.length &&
    LEGACY_DEFAULT_RELAY_URLS.every((url) => urls.has(url));
  return isLegacyDefault
    ? relays.filter((relay) => relay.url !== DAMUS_RELAY)
    : relays;
}
