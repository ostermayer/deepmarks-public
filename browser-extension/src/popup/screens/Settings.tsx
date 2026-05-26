// Settings — pixel-spirit-matches popup-screens-3.jsx ScreenSettings.
//
// The handoff specifies a 720×560 settings page that opens in its own
// tab (sidebar + main pane). Building that as a separate /settings.html
// is a v2 — for v1 we render the same five sections inline in the
// popup, scrollable. Same data model, same routes.
//
// Sections: Relays · Archiving · Default tags · Saved logins · Account.

import { useEffect, useState } from 'react';
import { colors, fonts, fontSize, lineHeight, space, radius } from '../../shared/tokens.js';
import { Pennant } from '../../shared/Pennant.js';
import { BackButton } from '../components/BackButton.js';
import { TagInput } from '../components/TagInput.js';
import {
  getSettings, importNip65Relays, patchSettings, pushSettingsToServer, revokeLogin, savedLoginLabel,
  type RelayConfig, type Settings as SettingsT, type BookmarkVisibility, type PublishMode,
} from '../../lib/settings-store.js';
import { discoverUserRelays } from '../../lib/nostr.js';
import { syncSettingsAndPublishedRelays } from '../../lib/relay-sync.js';
import {
  nsecStore,
  type NsecState,
} from '../../lib/nsec-store.js';
import { getLifetimeStatus } from '../../lib/archive.js';
import { clearNwc } from '../../lib/nwc-store.js';
import { ArchiveDefaultRow, NwcSection, SecuritySection } from './settings/AccountSections.js';
import { nip19 } from 'nostr-tools';

export function Settings({ state, onStateChange, onSignOut }: {
  state: NsecState;
  onStateChange: (s: NsecState) => void;
  onSignOut: () => void;
}) {
  const account = state; // local alias, lets the existing JSX keep using `account.pubkey` etc.
  const [settings, setSettings] = useState<SettingsT | null>(null);
  const [newRelay, setNewRelay] = useState('');
  const [newBlossom, setNewBlossom] = useState('');
  const [blossomError, setBlossomError] = useState<string | null>(null);
  const [isLifetime, setIsLifetime] = useState<boolean | null>(null);
  const [syncStatus, setSyncStatus] = useState('');
  const [relayScanStatus, setRelayScanStatus] = useState('');

  useEffect(() => {
    void getSettings().then(setSettings);
    if (state.nsecHex) {
      setSyncStatus('syncing settings...');
      void syncSettingsAndPublishedRelays(state.pubkey, state.nsecHex)
        .then((next) => {
          setSettings(next);
          setSyncStatus('settings synced');
        })
        .catch(() => setSyncStatus('local settings active'));
    }
  }, [state.nsecHex]);

  // Look up lifetime status on mount + every time the popup opens
  // while Settings is the active screen. Cheap unauthenticated GET.
  useEffect(() => {
    if (!state.pubkey) return;
    void getLifetimeStatus(state.pubkey)
      .then((s) => setIsLifetime(s.isLifetimeMember))
      .catch(() => setIsLifetime(false));
  }, [state.pubkey]);
  if (!settings) return null;
  const archiveDefaultEffective =
    isLifetime === true && (settings.archiveDefault || !settings.archiveDefaultManualOverride);

  async function update(patch: Partial<SettingsT>) {
    const shouldSync = hasSyncedSetting(patch);
    const next = await patchSettings(shouldSync
      ? { ...patch, pendingSync: true, syncedAt: Math.floor(Date.now() / 1000) }
      : patch);
    setSettings(next);
    if (!state.nsecHex || !shouldSync) return;
    setSyncStatus('saving settings...');
    try {
      const synced = await pushSettingsToServer(state.nsecHex, next);
      setSettings(synced);
      setSyncStatus('settings synced');
    } catch {
      setSyncStatus('saved locally; sync failed');
    }
  }

  async function addRelay() {
    const url = newRelay.trim();
    if (!/^wss?:\/\//.test(url)) return;
    if (settings!.relays.some((r) => r.url === url)) return;
    setNewRelay('');
    await update({ relays: [...settings!.relays, { url, read: true, write: true }] });
  }

  async function findRelays(opts: { quiet?: boolean } = {}) {
    if (!state.pubkey) return;
    if (!opts.quiet) setRelayScanStatus('looking for relays...');
    try {
      const discovered = await discoverUserRelays(state.pubkey);
      if (discovered.length === 0) {
        if (!opts.quiet) setRelayScanStatus('no NIP-65 relays found yet');
        return;
      }
      const next = await importNip65Relays(discovered);
      setSettings(next);
      if (state.nsecHex) {
        await pushSettingsToServer(state.nsecHex, next).catch(() => undefined);
      }
      if (!opts.quiet) {
        setRelayScanStatus(`synced ${next.relays.length} published relay${next.relays.length === 1 ? '' : 's'} from NIP-65`);
      }
    } catch (e) {
      if (!opts.quiet) setRelayScanStatus(`relay lookup failed: ${(e as Error).message}`);
    }
  }

  async function addBlossomServer() {
    setBlossomError(null);
    try {
      const url = normalizeBlossomUrl(newBlossom);
      if (settings!.backupBlossomServers.includes(url)) {
        setNewBlossom('');
        return;
      }
      if (settings!.backupBlossomServers.length >= 8) {
        throw new Error('up to 8 backup Blossom servers are supported');
      }
      setNewBlossom('');
      await update({ backupBlossomServers: [...settings!.backupBlossomServers, url] });
    } catch (e) {
      setBlossomError((e as Error).message);
    }
  }

  async function removeBlossomServer(url: string) {
    await update({ backupBlossomServers: settings!.backupBlossomServers.filter((v) => v !== url) });
  }

  return (
    <div style={page}>
      <header style={header}>
        <div style={brandRow}>
          <BackButton />
          <Pennant size={14} />
          <span style={brand}>Deepmarks</span>
        </div>
      </header>

      <div style={body}>
        {syncStatus && <div style={emptyHint}>{syncStatus}</div>}
        <Section title="Relays">
          <SelectRow
            label="Publish route"
            value={settings.publishMode}
            options={[
              ['deepmarks', 'via Deepmarks server (privacy)'],
              ['direct', 'direct to write relays'],
            ]}
            onChange={(v) => void update({ publishMode: v as PublishMode })}
          />
          <div style={emptyHint}>
            Server mode keeps your browser IP off public relays; direct mode publishes to relays marked w below.
          </div>
          <div style={relayList}>
            {settings.relays.map((r, i) => (
              <RelayRow
                key={r.url}
                relay={r}
                onChange={(next) => {
                  const updated = [...settings.relays];
                  updated[i] = next;
                  void update({ relays: updated });
                }}
                onDelete={() => void update({ relays: settings.relays.filter((_, j) => j !== i) })}
              />
            ))}
          </div>
          <div style={addRow}>
            <input
              type="text"
              placeholder="wss://relay.example.com"
              value={newRelay}
              onChange={(e) => setNewRelay(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void addRelay(); }}
              style={input}
            />
            <button style={addBtn} onClick={() => void addRelay()}>+ Add relay</button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <button style={secondaryBtn} onClick={() => void findRelays()} disabled={!state.pubkey}>
              rescan NIP-65 relays
            </button>
            {relayScanStatus && <div style={emptyHint}>{relayScanStatus}</div>}
          </div>
        </Section>

        <Section title="Archiving">
          <ArchiveDefaultRow
            value={archiveDefaultEffective}
            isLifetime={isLifetime}
            nsecHex={state.nsecHex}
            locked={state.locked}
            onChange={(v) => void update({ archiveDefault: v, archiveDefaultManualOverride: true })}
            onUpgraded={() => void getLifetimeStatus(state.pubkey!).then((s) => setIsLifetime(s.isLifetimeMember))}
          />
          {isLifetime && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 14 }}>
              <div style={emptyHint}>
                Deepmarks and Primal are used by default. Add paid or trusted Blossom servers you control for extra copies.
              </div>
              {settings.backupBlossomServers.length > 0 && (
                <div style={relayList}>
                  {settings.backupBlossomServers.map((url) => (
                    <div key={url} style={loginRow}>
                      <div style={loginMain}>
                        <div style={{ ...loginHost, fontFamily: fonts.mono, fontSize: fontSize.monoSmall }}>{url}</div>
                      </div>
                      <button style={revokeBtn} onClick={() => void removeBlossomServer(url)}>
                        remove
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div style={addRow}>
                <input
                  type="text"
                  placeholder="https://blossom.example.com"
                  value={newBlossom}
                  onChange={(e) => setNewBlossom(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void addBlossomServer(); }}
                  style={input}
                />
                <button style={addBtn} onClick={() => void addBlossomServer()}>+ Add backup</button>
              </div>
              {blossomError && (
                <div style={{ padding: 8, background: '#fbe9e3', color: '#8b2f17', borderRadius: 3, fontSize: 12 }}>
                  {blossomError}
                </div>
              )}
            </div>
          )}
        </Section>

        <Section title="New bookmark visibility">
          <SelectRow
            label="Default for new bookmarks"
            value={settings.defaultVisibility}
            options={[['private', 'private (encrypted to your key)'], ['public', 'public (visible on Nostr)']]}
            onChange={(v) => void update({ defaultVisibility: v as BookmarkVisibility })}
          />
        </Section>

        <Section title="Default tags">
          <TagInput
            value={settings.defaultTags}
            onChange={(v) => void update({ defaultTags: v })}
            placeholder="add a default tag…"
          />
        </Section>

        <Section title="Lightning wallet (NWC)">
          <NwcSection account={state} />
        </Section>

        <Section title="Saved logins">
          {settings.savedLogins.length === 0 ? (
            <div style={emptyHint}>No "Forever" grants yet. Sites you approve to sign with your key will show up here.</div>
          ) : (
            settings.savedLogins.map((l) => (
              <div key={l.origin} style={loginRow}>
                <div style={loginFavicon}>{originHost(l.origin).charAt(0).toUpperCase()}</div>
                <div style={loginMain}>
                  <div style={loginHost}>{originHost(l.origin)}</div>
                  <div style={loginMeta}>{savedLoginLabel(l)} · last used {relTime(l.lastUsedAt)}</div>
                </div>
                <button
                  style={revokeBtn}
                  onClick={async () => { await revokeLogin(l.origin, l); setSettings(await getSettings()); }}
                >
                  revoke
                </button>
              </div>
            ))
          )}
        </Section>

        <Section title="Security">
          <SecuritySection state={account} onStateChange={onStateChange} />
        </Section>

        <Section title="Account">
          <label style={accountLabel}>npub</label>
          <input
            readOnly
            value={account.pubkey ? nip19.npubEncode(account.pubkey) : ''}
            style={{ ...input, fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"', fontSize: fontSize.monoSmall }}
            onClick={(e) => (e.target as HTMLInputElement).select()}
          />
          {account.pubkey && (
            <a
              href={`https://deepmarks.org/u/${account.pubkey}`}
              target="_blank" rel="noreferrer"
              style={{ ...secondaryBtn, textAlign: 'center', textDecoration: 'none', display: 'block' }}
            >
              View on deepmarks ↗
            </a>
          )}
          <button
            style={dangerBtn}
            onClick={async () => {
              if (!confirm('Sign out and clear your nsec from this device?')) return;
              await clearNwc({ sync: false });
              await nsecStore.clear();
              onSignOut();
            }}
          >
            Sign out
          </button>
        </Section>
      </div>
    </div>
  );
}

function hasSyncedSetting(patch: Partial<SettingsT>): boolean {
  return 'relays' in patch ||
    'defaultTags' in patch ||
    'archiveDefault' in patch ||
    'archiveDefaultManualOverride' in patch ||
    'defaultVisibility' in patch ||
    'backupBlossomServers' in patch;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={section}>
      <h2 style={sectionH2}>{title}</h2>
      <div style={sectionBody}>{children}</div>
    </section>
  );
}

function RelayRow({ relay, onChange, onDelete }: {
  relay: RelayConfig;
  onChange: (next: RelayConfig) => void;
  onDelete: () => void;
}) {
  return (
    <div style={relayRow}>
      <code style={relayUrl}>{relay.url}</code>
      <ToggleSmall label="r" value={relay.read} onChange={(v) => onChange({ ...relay, read: v })} />
      <ToggleSmall label="w" value={relay.write} onChange={(v) => onChange({ ...relay, write: v })} />
      <button style={relayDelete} onClick={onDelete} aria-label={`remove ${relay.url}`}>×</button>
    </div>
  );
}

function ToggleSmall({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      title={label === 'r' ? 'read' : 'write'}
      style={{
        ...toggleSmall,
        background: value ? colors.accent : 'transparent',
        color: value ? '#fff' : colors.muted,
        borderColor: value ? colors.accent : colors.hairline,
      }}
      aria-pressed={value}
    >
      {label}
    </button>
  );
}

function SelectRow({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (v: string) => void;
}) {
  return (
    <div style={toggleRow}>
      <span style={toggleRowLabel}>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={select}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  );
}

function originHost(origin: string): string {
  try { return new URL(origin).hostname; } catch { return origin; }
}
function normalizeBlossomUrl(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error('enter a Blossom server URL');
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:') throw new Error('use an https Blossom server URL');
  if (!parsed.hostname.includes('.') || parsed.hostname === 'localhost' || parsed.hostname.endsWith('.local')) {
    throw new Error('use a public Blossom server hostname');
  }
  return parsed.origin;
}
function relTime(unix: number): string {
  const d = Math.floor(Date.now() / 1000) - unix;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

// ── Styles

const page: React.CSSProperties = {
  height: '100%', display: 'flex', flexDirection: 'column',
  background: colors.paper, color: colors.ink, fontFamily: fonts.sans,
};
const header: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: `${space.lg}px ${space.xl}px`,
  borderBottom: `1px solid ${colors.hairline}`,
};
const brandRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 };
const brand: React.CSSProperties = {
  fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.bodyMicro, fontWeight: 500, color: colors.accent,
};
const body: React.CSSProperties = {
  flex: 1, padding: `${space.lg}px ${space.xl}px`,
  overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: space.xl,
};
const section: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: space.sm };
const sectionH2: React.CSSProperties = {
  margin: 0, fontSize: fontSize.bodySmall, fontWeight: 500, color: colors.ink,
};
const sectionBody: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: space.sm };
const relayList: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4 };
const relayRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: space.sm,
  padding: `${space.xs}px ${space.sm}px`,
  border: `1px solid ${colors.hairlineSoft}`, borderRadius: radius.std,
  background: '#fff',
};
const relayUrl: React.CSSProperties = {
  flex: 1, minWidth: 0,
  fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.monoSmall, color: colors.inkSoft,
  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
};
const relayDelete: React.CSSProperties = {
  background: 'transparent', border: 'none', color: colors.muted,
  cursor: 'pointer', fontSize: 14, padding: '0 4px',
};
const addRow: React.CSSProperties = { display: 'flex', gap: space.sm, marginTop: space.sm };
const input: React.CSSProperties = {
  flex: 1, boxSizing: 'border-box', padding: `${space.sm}px ${space.lg}px`,
  border: `1px solid ${colors.hairline}`, borderRadius: radius.std,
  background: '#fff', color: colors.ink, fontSize: fontSize.bodyMicro,
  fontFamily: fonts.sans, outline: 'none',
};
const addBtn: React.CSSProperties = {
  padding: `${space.sm}px ${space.lg}px`,
  background: 'transparent', border: `1px solid ${colors.hairline}`,
  borderRadius: radius.std, cursor: 'pointer', fontSize: fontSize.metaSmall, color: colors.inkSoft,
  whiteSpace: 'nowrap',
};
const toggleRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space.lg,
  padding: `${space.xs}px 0`,
};
const toggleRowLabel: React.CSSProperties = {
  fontSize: fontSize.bodySmall, color: colors.inkSoft, lineHeight: lineHeight.body,
};
const toggleSmall: React.CSSProperties = {
  width: 22, height: 18, fontSize: 10, fontFamily: fonts.mono,
  border: '1px solid', borderRadius: radius.badge, cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};
const select: React.CSSProperties = {
  padding: `${space.xs}px ${space.sm}px`,
  border: `1px solid ${colors.hairline}`, borderRadius: radius.std,
  background: '#fff', fontSize: fontSize.metaSmall, fontFamily: fonts.sans, color: colors.inkSoft,
};
const emptyHint: React.CSSProperties = {
  fontSize: fontSize.metaSmall, color: colors.muted, lineHeight: lineHeight.body,
};
const loginRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: space.sm,
  padding: `${space.sm}px 0`, borderBottom: `1px solid ${colors.hairlineSoft}`,
};
const loginFavicon: React.CSSProperties = {
  width: 18, height: 18, borderRadius: 2, background: colors.tagBg,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  fontSize: 10, fontWeight: 600, color: colors.muted, flexShrink: 0,
};
const loginMain: React.CSSProperties = { flex: 1, minWidth: 0 };
const loginHost: React.CSSProperties = {
  fontSize: fontSize.metaSmall, color: colors.ink, fontWeight: 500,
};
const loginMeta: React.CSSProperties = {
  fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.uppercaseLabel, color: colors.muted,
};
const revokeBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', color: colors.muted,
  fontSize: fontSize.uppercaseLabel, cursor: 'pointer', textTransform: 'uppercase',
  letterSpacing: '0.08em',
};
const accountLabel: React.CSSProperties = {
  display: 'block', fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.uppercaseLabel, letterSpacing: '0.08em', fontWeight: 500,
  color: colors.muted, textTransform: 'uppercase', marginBottom: 4,
};
const secondaryBtn: React.CSSProperties = {
  marginTop: space.sm,
  padding: `${space.sm}px ${space.lg}px`,
  background: 'transparent', border: `1px solid ${colors.hairline}`,
  borderRadius: radius.std, fontSize: fontSize.metaSmall, color: colors.inkSoft,
  cursor: 'pointer',
};
const dangerBtn: React.CSSProperties = {
  marginTop: space.sm,
  padding: `${space.sm}px ${space.lg}px`,
  background: 'transparent', border: `1px solid ${colors.warn}`,
  borderRadius: radius.std, fontSize: fontSize.metaSmall, color: colors.warn,
  cursor: 'pointer',
};
