import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { colors, fonts, fontSize, lineHeight, space, radius } from '../../../shared/tokens.js';
import {
  deriveAccountEncryptionKey,
  getCachedAccountEncryptionKey,
  nsecStore,
  type CacheMode,
  type NsecState,
} from '../../../lib/nsec-store.js';
import {
  clearNwc,
  exportNwcForRekey,
  loadNwc,
  migrateNwcToEncrypted,
  parseNwcUri,
  saveNwc,
  saveNwcWithKey,
  type NwcConnection,
} from '../../../lib/nwc-store.js';
import { startLifetimeCheckout, type LifetimeCheckout } from '../../../lib/archive.js';
import { IS_APPLE_BUILD } from '../../../lib/build-flags.js';
import { buildNsecBackupText, nsecQrDataUrl } from '../../../lib/nsec-backup.js';
import { navigate } from '../../router.js';

export function NwcSection({ account }: { account: NsecState }) {
  const [conn, setConn] = useState<NwcConnection | null>(null);
  const [locked, setLocked] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    setLocked(false);
    void loadNwc()
      .then((c) => { setConn(c); })
      .catch((e) => {
        setConn(null);
        setLocked(true);
        setError((e as Error).message);
      });
  }, [account.locked, account.protected]);

  async function connect() {
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      const parsed = parseNwcUri(draft);
      await saveNwc(parsed);
      setConn(parsed);
      setDraft('');
      setMessage('connected on this browser');
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

  if (!account.protected) {
    return (
      <div>
        <div style={emptyHint}>
          Set a Deepmarks password before connecting NWC. Production builds do
          not store new wallet spending secrets without password protection.
        </div>
        <button style={secondaryBtn} onClick={() => navigate('set-password')}>
          Set password
        </button>
      </div>
    );
  }

  if (account.locked || locked) {
    return (
      <div>
        <div style={emptyHint}>
          Unlock your Deepmarks password to manage or use the wallet connection.
        </div>
        <button style={secondaryBtn} onClick={() => navigate('unlock')}>
          Unlock
        </button>
        {error && <div style={{ ...emptyHint, color: '#a33', marginTop: 6 }}>{error}</div>}
      </div>
    );
  }

  if (conn) {
    return (
      <div>
        <div style={emptyHint}>
          Connected to wallet <code>{conn.walletPubkey.slice(0, 12)}...</code> via{' '}
          <code>{conn.relayUrl}</code>. Zap-capable extension flows can use
          this wallet after local approval. The NWC secret is encrypted locally
          and stays on this browser.
        </div>
        <button
          style={revokeBtn}
          onClick={() => void disconnect()}
          disabled={busy}
        >
          {busy ? '...' : 'disconnect'}
        </button>
        {message && <div style={{ ...emptyHint, color: colors.accent, marginTop: 6 }}>{message}</div>}
      </div>
    );
  }

  return (
    <div>
      <div style={emptyHint}>
        Paste a <code>nostr+walletconnect://</code> URI from your wallet
        (Alby Hub, Mutiny, Coinos, ZBD, ...) to keep one-tap zap payments available.
        The secret is encrypted with your Deepmarks password locally and synced
        to your Deepmarks apps with NIP-44 encryption.
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="nostr+walletconnect://..."
        style={textarea}
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
          {busy ? 'connecting...' : 'connect'}
        </button>
      </div>
      {error && <div style={{ ...emptyHint, color: '#a33', marginTop: 6 }}>{error}</div>}
    </div>
  );
}

export function ArchiveDefaultRow({ value, isLifetime, nsecHex, locked, onChange, onUpgraded }: {
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
    if (IS_APPLE_BUILD) {
      setError('Archive all new bookmarks is for lifetime members.');
      return;
    }
    if (locked || !nsecHex) {
      setError('Unlock Deepmarks first to start the lifetime upgrade.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setCheckout(await startLifetimeCheckout(nsecHex));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!checkout) return;
    const id = setInterval(() => onUpgraded(), 6000);
    return () => clearInterval(id);
  }, [checkout, onUpgraded]);

  useEffect(() => {
    if (checkout && isLifetime) {
      setCheckout(null);
      onChange(true);
    }
  }, [checkout, isLifetime, onChange]);

  if (isLifetime === null) return <div style={emptyHint}>Checking lifetime status...</div>;

  if (!isLifetime) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <ToggleRow label="Archive all new bookmarks" value={false} onChange={handleToggle} />
        <div style={emptyHint}>Archiving is included with lifetime membership.</div>
        {!IS_APPLE_BUILD && (
          <button type="button" style={secondaryBtn} onClick={() => void handleToggle(true)} disabled={busy}>
            {busy ? 'preparing checkout...' : 'Upgrade to lifetime'}
          </button>
        )}
        {error && <ErrorBox>{error}</ErrorBox>}
        {checkout && !IS_APPLE_BUILD && <CheckoutPanel checkout={checkout} onCancel={() => setCheckout(null)} />}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <ToggleRow label="Archive all new bookmarks" value={value} onChange={handleToggle} />
      {busy && <div style={{ fontSize: 12, color: '#827d72' }}>preparing checkout...</div>}
      {error && <ErrorBox>{error}</ErrorBox>}
      {checkout && !IS_APPLE_BUILD && <CheckoutPanel checkout={checkout} onCancel={() => setCheckout(null)} />}
    </div>
  );
}

function CheckoutPanel({ checkout, onCancel }: { checkout: LifetimeCheckout; onCancel: () => void }) {
  return (
    <div style={checkoutPanel}>
      <div style={{ fontSize: 13, color: '#1a1a1a', fontWeight: 500 }}>
        Upgrade to lifetime - {checkout.amountSats.toLocaleString('en-US')} sats
      </div>
      <div style={{ fontSize: 12, color: '#3d3a35', lineHeight: 1.5 }}>
        One-time payment unlocks archives, the API, and short usernames.
        Pay with any Lightning wallet OR on-chain BTC - both shown on the next page.
      </div>
      <a href={checkout.checkoutLink} target="_blank" rel="noreferrer" style={checkoutLink}>
        Pay with Lightning or BTC
      </a>
      <button type="button" onClick={onCancel} style={plainSmallBtn}>cancel</button>
      <div style={{ fontSize: 11, color: '#827d72', textAlign: 'center' }}>
        this panel closes automatically once we detect payment
      </div>
    </div>
  );
}

export function SecuritySection({ state, onStateChange }: {
  state: NsecState;
  onStateChange: (s: NsecState) => void;
}) {
  const [mode, setMode] = useState<CacheMode>('session');
  const [pwUi, setPwUi] = useState<
    | { kind: 'idle' }
    | { kind: 'set'; pw: string; pw2: string }
    | { kind: 'change'; old: string; pw: string; pw2: string }
    | { kind: 'reveal-prompt'; old: string }
  >({ kind: 'idle' });
  const [reveal, setReveal] = useState<{
    nsec: string;
    copied: boolean;
    qrDataUrl?: string;
    qrVisible?: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        const next = await nsecStore.setPassword(pwUi.pw, mode);
        const key = await getCachedAccountEncryptionKey();
        if (key) await migrateNwcToEncrypted(key);
        onStateChange(next);
        reset();
      } else if (pwUi.kind === 'change') {
        if (!pwUi.pw || pwUi.pw !== pwUi.pw2) throw new Error('new passwords do not match');
        const oldKey = await deriveAccountEncryptionKey(pwUi.old);
        const nwc = await exportNwcForRekey(oldKey);
        const next = await nsecStore.changePassword(pwUi.old, pwUi.pw, mode);
        const newKey = await getCachedAccountEncryptionKey();
        if (nwc && newKey) await saveNwcWithKey(nwc, newKey);
        onStateChange(next);
        reset();
      } else if (pwUi.kind === 'reveal-prompt') {
        const nsec = await nsecStore.revealNsecBech32WithPassword(pwUi.old);
        await showNsec(nsec);
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
    if (state.protected) { setPwUi({ kind: 'reveal-prompt', old: '' }); return; }
    try {
      const nsec = await nsecStore.revealNsecBech32();
      await showNsec(nsec);
    } catch (e) { setError((e as Error).message); }
  }

  async function showNsec(nsec: string) {
    setReveal({ nsec, copied: false });
  }

  async function showQr() {
    if (!reveal) return;
    if (reveal.qrDataUrl) {
      setReveal({ ...reveal, qrVisible: !reveal.qrVisible });
      return;
    }
    setReveal({ ...reveal, qrVisible: true });
    try {
      const qrDataUrl = await nsecQrDataUrl(reveal.nsec);
      setReveal((current) => (
        current?.nsec === reveal.nsec ? { ...current, qrDataUrl, qrVisible: true } : current
      ));
    } catch {
      // The text export still includes an ASCII QR.
    }
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
    const content = buildNsecBackupText({ nsec: reveal.nsec, timestampLabel: 'Downloaded' });
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
      {state.protected && (
        <div style={emptyHint}>
          Revealing the nsec always asks for this password, even while the extension is unlocked for signing.
        </div>
      )}
      {pwUi.kind === 'idle' && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {!state.protected ? (
            <button style={secondaryBtn} onClick={() => setPwUi({ kind: 'set', pw: '', pw2: '' })}>
              Set password
            </button>
          ) : (
            <>
              <button style={secondaryBtn} onClick={() => setPwUi({ kind: 'change', old: '', pw: '', pw2: '' })}>Change password</button>
              <button style={secondaryBtn} onClick={() => void nsecStore.lock().then((s) => { onStateChange(s); navigate('unlock'); })}>Lock now</button>
            </>
          )}
          <button style={secondaryBtn} onClick={() => void revealNsec()}>Reveal nsec</button>
        </div>
      )}
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
      {pwUi.kind === 'reveal-prompt' && (
        <PwForm
          fields={[{ label: 'password', value: pwUi.old, onChange: (v) => setPwUi({ ...pwUi, old: v }) }]}
          onCommit={() => void commit()}
          onCancel={reset}
          busy={busy}
          submitLabel="Reveal nsec"
        />
      )}
      {error && <ErrorBox>{error}</ErrorBox>}
      {reveal && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          <div style={revealBox}>{reveal.nsec}</div>
          {reveal.qrVisible && reveal.qrDataUrl && <img src={reveal.qrDataUrl} alt="Recovery key QR code" style={qrImage} />}
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={secondaryBtn} onClick={() => void copyNsec()}>{reveal.copied ? 'copied' : 'copy nsec'}</button>
            <button style={secondaryBtn} onClick={() => void showQr()}>
              {reveal.qrVisible ? 'hide QR' : 'show QR'}
            </button>
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
          style={passwordInput}
        />
      ))}
      {mode && onModeChange && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
          <label style={radioLabel}>
            <input type="radio" checked={mode === 'session'} onChange={() => onModeChange('session')} />
            <span>Prompt when browser reopens</span>
          </label>
          <label style={radioLabel}>
            <input type="radio" checked={mode === 'days30'} onChange={() => onModeChange('days30')} />
            <span>Stay unlocked for 30 days</span>
          </label>
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        <button style={secondaryBtn} onClick={onCancel} disabled={busy}>Cancel</button>
        <button style={{ ...secondaryBtn, background: '#1a1a1a', color: '#fbfaf7', borderColor: '#1a1a1a' }} onClick={onCommit} disabled={busy}>
          {busy ? '...' : submitLabel}
        </button>
      </div>
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

function ErrorBox({ children }: { children: string }) {
  return <div style={{ padding: 8, background: '#fbe9e3', color: '#8b2f17', borderRadius: 3, fontSize: 12 }}>{children}</div>;
}

const emptyHint: CSSProperties = {
  fontSize: fontSize.metaSmall,
  color: colors.muted,
  lineHeight: lineHeight.body,
};
const secondaryBtn: CSSProperties = {
  marginTop: space.sm,
  padding: `${space.sm}px ${space.lg}px`,
  background: 'transparent',
  border: `1px solid ${colors.hairline}`,
  borderRadius: radius.std,
  fontSize: fontSize.metaSmall,
  color: colors.inkSoft,
  cursor: 'pointer',
};
const revokeBtn: CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: colors.muted,
  fontSize: fontSize.uppercaseLabel,
  cursor: 'pointer',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
};
const textarea: CSSProperties = {
  width: '100%',
  minHeight: 60,
  marginTop: 8,
  padding: `${space.sm}px ${space.md}px`,
  border: `1px solid ${colors.hairline}`,
  borderRadius: radius.std,
  background: '#fff',
  color: colors.ink,
  fontFamily: fonts.mono,
  fontSize: fontSize.monoSmall,
  resize: 'vertical',
  outline: 'none',
};
const toggleRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: space.lg,
  padding: `${space.xs}px 0`,
};
const toggleRowLabel: CSSProperties = {
  fontSize: fontSize.bodySmall,
  color: colors.inkSoft,
  lineHeight: lineHeight.body,
};
const toggle: CSSProperties = {
  width: 28,
  height: 16,
  padding: 2,
  borderRadius: 9,
  border: 'none',
  cursor: 'pointer',
  flexShrink: 0,
  transition: 'background 0.15s',
  position: 'relative',
};
const toggleKnob: CSSProperties = {
  display: 'block',
  width: 12,
  height: 12,
  borderRadius: '50%',
  background: '#fff',
  transition: 'transform 0.15s',
};
const checkoutPanel: CSSProperties = {
  padding: 12,
  background: '#f4f1e9',
  border: '1px solid #e6e2d8',
  borderRadius: 3,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};
const checkoutLink: CSSProperties = {
  display: 'block',
  textAlign: 'center',
  textDecoration: 'none',
  padding: '10px 14px',
  background: '#1a1a1a',
  color: '#fbfaf7',
  borderRadius: 3,
  fontSize: 13,
  fontWeight: 500,
};
const plainSmallBtn: CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#827d72',
  fontSize: 11,
  cursor: 'pointer',
  padding: 0,
};
const passwordInput: CSSProperties = {
  padding: '8px 10px',
  border: '1px solid #e6e2d8',
  borderRadius: 3,
  fontSize: 12,
};
const radioLabel: CSSProperties = {
  fontSize: 11,
  color: '#3d3a35',
  display: 'flex',
  gap: 6,
  alignItems: 'center',
};
const revealBox: CSSProperties = {
  fontFamily: 'ui-monospace, monospace',
  fontSize: 11,
  padding: 10,
  background: '#fff',
  border: '1px solid #e6e2d8',
  borderRadius: 3,
  wordBreak: 'break-all',
};
const qrImage: CSSProperties = {
  width: 160,
  height: 160,
  background: '#fff',
  border: '1px solid #e6e2d8',
  borderRadius: 3,
};
