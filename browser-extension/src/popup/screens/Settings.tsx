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
  getSettings, patchSettings, revokeLogin,
  type RelayConfig, type Settings as SettingsT, type BookmarkVisibility,
} from '../../lib/settings-store.js';
import { nsecStore, type NsecState, type CacheMode } from '../../lib/nsec-store.js';
import { getLifetimeStatus, startLifetimeCheckout, type LifetimeCheckout } from '../../lib/archive.js';
import { loadNwc, saveNwc, clearNwc, parseNwcUri, type NwcConnection } from '../../lib/nwc-store.js';
import { navigate } from '../router.js';
import { nip19 } from 'nostr-tools';

export function Settings({ state, onStateChange, onSignOut }: {
  state: NsecState;
  onStateChange: (s: NsecState) => void;
  onSignOut: () => void;
}) {
  const account = state; // local alias, lets the existing JSX keep using `account.pubkey` etc.
  const [settings, setSettings] = useState<SettingsT | null>(null);
  const [newRelay, setNewRelay] = useState('');
  const [isLifetime, setIsLifetime] = useState<boolean | null>(null);

  useEffect(() => { void getSettings().then(setSettings); }, []);
  // Look up lifetime status on mount + every time the popup opens
  // while Settings is the active screen. Cheap unauthenticated GET.
  useEffect(() => {
    if (!state.pubkey) return;
    void getLifetimeStatus(state.pubkey)
      .then((s) => setIsLifetime(s.isLifetimeMember))
      .catch(() => setIsLifetime(false));
  }, [state.pubkey]);
  if (!settings) return null;

  async function update(patch: Partial<SettingsT>) {
    const next = await patchSettings(patch);
    setSettings(next);
  }

  async function addRelay() {
    const url = newRelay.trim();
    if (!/^wss?:\/\//.test(url)) return;
    if (settings!.relays.some((r) => r.url === url)) return;
    setNewRelay('');
    await update({ relays: [...settings!.relays, { url, read: true, write: true }] });
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
        <Section title="Relays">
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
        </Section>

        <Section title="Archiving">
          <ArchiveDefaultRow
            value={settings.archiveDefault}
            isLifetime={isLifetime}
            nsecHex={state.nsecHex}
            locked={state.locked}
            onChange={(v) => void update({ archiveDefault: v })}
            onUpgraded={() => void getLifetimeStatus(state.pubkey!).then((s) => setIsLifetime(s.isLifetimeMember))}
          />
          <ToggleRow
            label="Only archive pages over a paywall I have access to"
            value={settings.archiveOnlyPaywalled}
            onChange={(v) => void update({ archiveOnlyPaywalled: v })}
          />
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
          <NwcSection />
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
                  <div style={loginMeta}>last used {relTime(l.lastUsedAt)}</div>
                </div>
                <button
                  style={revokeBtn}
                  onClick={async () => { await revokeLogin(l.origin); setSettings(await getSettings()); }}
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

// ── Archive-default row: lifetime-gated ──────────────────────────────
//
// Lifetime members get unlimited free archives — for them the toggle
// is unconstrained. Free users pay 500 sats per archive, so turning
// this on without lifetime would cost a fortune; we route them
// through a one-time-payment upgrade flow instead. The "open BTCPay
// checkout in a new tab" path is the same flow the web app uses;
// once paid, the next status fetch flips them to lifetime and the
// toggle activates.

// NWC (NIP-47) connection panel. The user pastes a connection URI
// from their wallet (Alby Hub, Mutiny, Coinos, ZBD, …) and we store
// it in chrome.storage.local. Once connected, the InvoiceCard surfaces
// a "Pay with NWC" button that ships pay_invoice through the wallet's
// relay and shows the preimage on success.
//
// Disconnect simply deletes the connection record — the wallet doesn't
// need to be told; the URI's secret stops being used and is the only
// thing tying our requests to that wallet.
function NwcSection() {
  const [conn, setConn] = useState<NwcConnection | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void loadNwc().then(setConn); }, []);

  async function connect() {
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      const parsed = parseNwcUri(draft);
      await saveNwc(parsed);
      setConn(parsed);
      setDraft('');
      setMessage('connected');
    } catch (e) {
      setError((e as Error).message ?? 'connection failed');
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      await clearNwc();
      setConn(null);
      setMessage('disconnected');
    } finally {
      setBusy(false);
    }
  }

  if (conn) {
    return (
      <div>
        <div style={emptyHint}>
          Connected to wallet <code>{conn.walletPubkey.slice(0, 12)}…</code> via{' '}
          <code>{conn.relayUrl}</code>. Lightning payments from the extension
          will flow through this wallet — no QR scanning, one tap.
        </div>
        <button
          style={revokeBtn}
          onClick={() => void disconnect()}
          disabled={busy}
        >
          {busy ? '…' : 'disconnect'}
        </button>
        {message && <div style={{ ...emptyHint, color: colors.accent, marginTop: 6 }}>{message}</div>}
      </div>
    );
  }

  return (
    <div>
      <div style={emptyHint}>
        Paste a <code>nostr+walletconnect://</code> URI from your wallet
        (Alby Hub, Mutiny, Coinos, ZBD, …) to enable one-tap payments
        for archives + zaps. The secret never leaves this browser.
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="nostr+walletconnect://..."
        style={{
          width: '100%', minHeight: 60, marginTop: 8,
          padding: `${space.sm}px ${space.md}px`,
          border: `1px solid ${colors.hairline}`,
          borderRadius: radius.std,
          background: '#fff',
          color: colors.ink,
          fontFamily: fonts.mono,
          fontSize: fontSize.monoSmall,
          resize: 'vertical',
          outline: 'none',
        }}
        spellCheck={false}
      />
      <div style={{ display: 'flex', gap: space.sm, marginTop: space.sm }}>
        <button
          style={{
            ...revokeBtn,
            background: colors.ink,
            color: colors.paper,
            borderColor: colors.ink,
          }}
          onClick={() => void connect()}
          disabled={busy || !draft.trim()}
        >
          {busy ? 'connecting…' : 'connect'}
        </button>
      </div>
      {error && <div style={{ ...emptyHint, color: '#a33', marginTop: 6 }}>{error}</div>}
    </div>
  );
}

function ArchiveDefaultRow({ value, isLifetime, nsecHex, locked, onChange, onUpgraded }: {
  value: boolean;
  isLifetime: boolean | null;
  nsecHex: string | null;
  locked: boolean;
  onChange: (v: boolean) => void;
  onUpgraded: () => void;
}) {
  const [checkout, setCheckout] = useState<LifetimeCheckout | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleToggle(next: boolean) {
    if (!next) { onChange(false); return; }
    if (isLifetime) { onChange(true); return; }
    if (locked || !nsecHex) {
      setError('Unlock your nsec first to upgrade');
      return;
    }
    // Not lifetime + turning on → start the upgrade flow.
    setBusy(true);
    setError(null);
    try {
      const c = await startLifetimeCheckout(nsecHex);
      setCheckout(c);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Poll for upgrade completion while a checkout is open.
  useEffect(() => {
    if (!checkout) return;
    const id = setInterval(() => onUpgraded(), 6000);
    return () => clearInterval(id);
  }, [checkout, onUpgraded]);

  // If lifetime came in (via polling) while the checkout panel is up,
  // close the panel and flip the toggle on automatically.
  useEffect(() => {
    if (checkout && isLifetime) {
      setCheckout(null);
      onChange(true);
    }
  }, [checkout, isLifetime, onChange]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <ToggleRow
        label={isLifetime
          ? 'Archive new bookmarks by default (free for lifetime members)'
          : 'Archive new bookmarks by default — requires lifetime upgrade'}
        value={value}
        onChange={handleToggle}
      />
      {busy && <div style={{ fontSize: 12, color: '#827d72' }}>preparing checkout…</div>}
      {error && <div style={{ padding: 8, background: '#fbe9e3', color: '#8b2f17', borderRadius: 3, fontSize: 12 }}>{error}</div>}
      {checkout && (
        <div style={{ padding: 12, background: '#f4f1e9', border: '1px solid #e6e2d8', borderRadius: 3, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 13, color: '#1a1a1a', fontWeight: 500 }}>
            Upgrade to lifetime — {checkout.amountSats.toLocaleString()} sats
          </div>
          <div style={{ fontSize: 12, color: '#3d3a35', lineHeight: 1.5 }}>
            One-time payment unlocks free archives, the API, and short usernames.
            Pay with any Lightning wallet OR on-chain BTC — both shown on the next page.
          </div>
          <a
            href={checkout.checkoutLink}
            target="_blank"
            rel="noreferrer"
            style={{
              display: 'block', textAlign: 'center', textDecoration: 'none',
              padding: '10px 14px', background: '#1a1a1a', color: '#fbfaf7',
              borderRadius: 3, fontSize: 13, fontWeight: 500,
            }}
          >
            Pay with Lightning or BTC ↗
          </a>
          <button
            type="button"
            onClick={() => setCheckout(null)}
            style={{
              background: 'transparent', border: 'none', color: '#827d72',
              fontSize: 11, cursor: 'pointer', padding: 0,
            }}
          >
            cancel
          </button>
          <div style={{ fontSize: 11, color: '#827d72', textAlign: 'center' }}>
            this panel closes automatically once we detect payment
          </div>
        </div>
      )}
    </div>
  );
}

// ── Security section: password protection + reveal nsec ──────────────

function SecuritySection({ state, onStateChange }: {
  state: NsecState;
  onStateChange: (s: NsecState) => void;
}) {
  const [mode, setMode] = useState<CacheMode>('session');
  const [pwUi, setPwUi] = useState<
    | { kind: 'idle' }
    | { kind: 'set'; pw: string; pw2: string }
    | { kind: 'change'; old: string; pw: string; pw2: string }
    | { kind: 'remove'; old: string }
    | { kind: 'reveal-prompt'; old: string }
  >({ kind: 'idle' });
  const [reveal, setReveal] = useState<{ nsec: string; copied: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auto-hide the revealed nsec after 30s. Without this, an unattended
  // popup leaves the cleartext nsec sitting in React state visible to
  // anyone walking past the screen (or anyone with content-script
  // access via React DevTools). 30s is enough to copy / download but
  // short enough that "I forgot to hide it" stays a near-miss.
  useEffect(() => {
    if (!reveal) return;
    const t = setTimeout(() => setReveal(null), 30_000);
    return () => clearTimeout(t);
  }, [reveal]);

  function reset() { setPwUi({ kind: 'idle' }); setError(null); }

  async function commit() {
    setBusy(true);
    setError(null);
    try {
      if (pwUi.kind === 'set') {
        if (!pwUi.pw || pwUi.pw !== pwUi.pw2) throw new Error('passwords do not match');
        if (pwUi.pw.length < 8) throw new Error('password must be at least 8 characters');
        onStateChange(await nsecStore.setPassword(pwUi.pw, mode));
        reset();
      } else if (pwUi.kind === 'change') {
        if (!pwUi.pw || pwUi.pw !== pwUi.pw2) throw new Error('new passwords do not match');
        onStateChange(await nsecStore.changePassword(pwUi.old, pwUi.pw, mode));
        reset();
      } else if (pwUi.kind === 'remove') {
        if (!confirm('Remove password protection? Your nsec will be stored in plaintext again.')) return;
        onStateChange(await nsecStore.removePassword(pwUi.old));
        reset();
      } else if (pwUi.kind === 'reveal-prompt') {
        // Peek-only: decrypt with the password but do NOT cache the
        // derived key. Otherwise the cache-mode picker on this prompt
        // would silently extend the unlock window for everything else
        // (NIP-07 signing, archive purchases, etc.) just because the
        // user wanted to copy their nsec once.
        const nsec = await nsecStore.revealNsecBech32WithPassword(pwUi.old);
        setReveal({ nsec, copied: false });
        reset();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revealNsec() {
    setError(null);
    if (state.locked) { setPwUi({ kind: 'reveal-prompt', old: '' }); return; }
    try {
      const nsec = await nsecStore.revealNsecBech32();
      setReveal({ nsec, copied: false });
    } catch (e) { setError((e as Error).message); }
  }

  async function copyNsec() {
    if (!reveal) return;
    try {
      await navigator.clipboard.writeText(reveal.nsec);
      setReveal({ ...reveal, copied: true });
      setTimeout(() => setReveal((r) => (r ? { ...r, copied: false } : r)), 1500);
    } catch { /* clipboard refused */ }
  }

  function downloadNsec() {
    if (!reveal) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const content = [
      `# Deepmarks — Nostr identity backup`,
      `# Exported ${new Date().toISOString()}`,
      ``,
      `nsec: ${reveal.nsec}`,
    ].join('\n');
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `deepmarks-nsec-${stamp}.txt`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 13, color: 'var(--ink, #1a1a1a)' }}>
        Password protection: <strong>{state.protected ? 'on' : 'off'}</strong>
      </div>

      {/* Action buttons */}
      {pwUi.kind === 'idle' && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {!state.protected ? (
            <button style={secondaryBtn} onClick={() => setPwUi({ kind: 'set', pw: '', pw2: '' })}>
              Set password
            </button>
          ) : (
            <>
              <button style={secondaryBtn} onClick={() => setPwUi({ kind: 'change', old: '', pw: '', pw2: '' })}>Change password</button>
              <button style={secondaryBtn} onClick={() => setPwUi({ kind: 'remove', old: '' })}>Remove password</button>
              <button style={secondaryBtn} onClick={() => void nsecStore.lock().then((s) => { onStateChange(s); navigate('unlock'); })}>Lock now</button>
            </>
          )}
          <button style={secondaryBtn} onClick={() => void revealNsec()}>Reveal nsec</button>
        </div>
      )}

      {/* Set password */}
      {pwUi.kind === 'set' && (
        <PwForm
          fields={[
            { label: 'new password', value: pwUi.pw, onChange: (v) => setPwUi({ ...pwUi, pw: v }) },
            { label: 'confirm password', value: pwUi.pw2, onChange: (v) => setPwUi({ ...pwUi, pw2: v }) },
          ]}
          mode={mode}
          onModeChange={setMode}
          onCommit={() => void commit()}
          onCancel={reset}
          busy={busy}
          submitLabel="Set password"
        />
      )}
      {pwUi.kind === 'change' && (
        <PwForm
          fields={[
            { label: 'current password', value: pwUi.old, onChange: (v) => setPwUi({ ...pwUi, old: v }) },
            { label: 'new password', value: pwUi.pw, onChange: (v) => setPwUi({ ...pwUi, pw: v }) },
            { label: 'confirm new password', value: pwUi.pw2, onChange: (v) => setPwUi({ ...pwUi, pw2: v }) },
          ]}
          mode={mode}
          onModeChange={setMode}
          onCommit={() => void commit()}
          onCancel={reset}
          busy={busy}
          submitLabel="Change password"
        />
      )}
      {pwUi.kind === 'remove' && (
        <PwForm
          fields={[
            { label: 'current password', value: pwUi.old, onChange: (v) => setPwUi({ ...pwUi, old: v }) },
          ]}
          onCommit={() => void commit()}
          onCancel={reset}
          busy={busy}
          submitLabel="Remove password"
        />
      )}
      {pwUi.kind === 'reveal-prompt' && (
        <PwForm
          fields={[
            { label: 'password', value: pwUi.old, onChange: (v) => setPwUi({ ...pwUi, old: v }) },
          ]}
          onCommit={() => void commit()}
          onCancel={reset}
          busy={busy}
          submitLabel="Reveal nsec"
        />
      )}

      {error && <div style={{ padding: 8, background: '#fbe9e3', color: '#8b2f17', borderRadius: 3, fontSize: 12 }}>{error}</div>}

      {/* Revealed nsec block */}
      {reveal && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, padding: 10, background: '#fff', border: '1px solid #e6e2d8', borderRadius: 3, wordBreak: 'break-all' }}>
            {reveal.nsec}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={secondaryBtn} onClick={() => void copyNsec()}>{reveal.copied ? 'copied ✓' : 'copy nsec'}</button>
            <button style={secondaryBtn} onClick={downloadNsec}>download .txt</button>
            <button style={secondaryBtn} onClick={() => setReveal(null)}>hide</button>
          </div>
        </div>
      )}
    </div>
  );
}

function PwForm({ fields, mode, onModeChange, onCommit, onCancel, busy, submitLabel }: {
  fields: { label: string; value: string; onChange: (v: string) => void }[];
  mode?: CacheMode;
  onModeChange?: (m: CacheMode) => void;
  onCommit: () => void;
  onCancel: () => void;
  busy: boolean;
  submitLabel: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {fields.map((f) => (
        <input
          key={f.label}
          type="password"
          placeholder={f.label}
          value={f.value}
          onChange={(e) => f.onChange(e.target.value)}
          style={{ padding: '8px 10px', border: '1px solid #e6e2d8', borderRadius: 3, fontSize: 12 }}
        />
      ))}
      {mode && onModeChange && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
          <label style={{ fontSize: 11, color: '#3d3a35', display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="radio" checked={mode === 'session'} onChange={() => onModeChange('session')} />
            <span>Prompt when browser reopens</span>
          </label>
          <label style={{ fontSize: 11, color: '#3d3a35', display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="radio" checked={mode === 'days30'} onChange={() => onModeChange('days30')} />
            <span>Remember for 30 days</span>
          </label>
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        <button style={secondaryBtn} onClick={onCancel} disabled={busy}>Cancel</button>
        <button style={{ ...secondaryBtn, background: '#1a1a1a', color: '#fbfaf7', borderColor: '#1a1a1a' }} onClick={onCommit} disabled={busy}>
          {busy ? '…' : submitLabel}
        </button>
      </div>
    </div>
  );
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

function ToggleRow({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div style={toggleRow}>
      <span style={toggleRowLabel}>{label}</span>
      <button
        type="button"
        onClick={() => onChange(!value)}
        style={{ ...toggle, background: value ? colors.accent : colors.hairline }}
        aria-pressed={value}
      >
        <span style={{ ...toggleKnob, transform: value ? 'translateX(12px)' : 'translateX(0)' }} />
      </button>
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
const toggle: React.CSSProperties = {
  width: 28, height: 16, padding: 2, borderRadius: 9,
  border: 'none', cursor: 'pointer', flexShrink: 0,
  transition: 'background 0.15s', position: 'relative',
};
const toggleKnob: React.CSSProperties = {
  display: 'block', width: 12, height: 12, borderRadius: '50%',
  background: '#fff', transition: 'transform 0.15s',
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
