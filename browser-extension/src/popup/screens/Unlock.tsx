// Unlock screen — shown when the stored nsec is password-protected
// AND we don't have a cached derived key (browser was just opened, or
// the user explicitly chose "lock now" from Settings).
//
// Single password input + cache-mode picker + Unlock button. On
// success, lifts the new NsecState back to App which re-renders the
// caller into the screen they were trying to reach.

import { useState } from 'react';
import { colors, fonts, fontSize, lineHeight, space, radius } from '../../shared/tokens.js';
import { Pennant } from '../../shared/Pennant.js';
import { nsecStore, type NsecState, type CacheMode } from '../../lib/nsec-store.js';
import { syncSettingsAndPublishedRelays } from '../../lib/relay-sync.js';
import { nip19 } from 'nostr-tools';
import { clearNwc } from '../../lib/nwc-store.js';

export function Unlock({ state, onUnlocked }: {
  state: NsecState;
  onUnlocked: (s: NsecState) => void;
}) {
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<CacheMode>('session');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [recoveryNsec, setRecoveryNsec] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newPasswordConfirm, setNewPasswordConfirm] = useState('');

  async function unlock() {
    setError(null);
    setBusy(true);
    try {
      const next = await nsecStore.unlock(password, mode);
      if (next.nsecHex) void syncSettingsAndPublishedRelays(next.pubkey, next.nsecHex).catch(() => undefined);
      void chrome.runtime.sendMessage({ kind: 'archive-backfill-run' }).catch(() => undefined);
      onUnlocked(next);
    } catch (e) {
      setError((e as Error).message ?? 'wrong password');
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  const validRecoveryNsec = recoveryNsec.trim().startsWith('nsec1') && recoveryNsec.trim().length >= 60;
  const recoveryPasswordTooShort = newPassword.length > 0 && newPassword.length < 8;
  const recoveryPasswordMismatch = newPasswordConfirm.length > 0 && newPassword !== newPasswordConfirm;
  const validRecoveryPassword = newPassword.length >= 8 && newPassword === newPasswordConfirm;
  const canRecover = validRecoveryNsec && validRecoveryPassword;

  async function recoverWithNsec() {
    if (!canRecover) return;
    setError(null);
    setBusy(true);
    try {
      const next = await nsecStore.setEncrypted(recoveryNsec.trim(), newPassword, mode);
      await clearNwc({ sync: false }).catch(() => undefined);
      if (next.nsecHex) void syncSettingsAndPublishedRelays(next.pubkey, next.nsecHex).catch(() => undefined);
      void chrome.runtime.sendMessage({ kind: 'archive-backfill-run' }).catch(() => undefined);
      onUnlocked(next);
    } catch (e) {
      setError((e as Error).message ?? 'could not restore from nsec');
    } finally {
      setBusy(false);
    }
  }

  const npub = state.pubkey ? nip19.npubEncode(state.pubkey) : '';

  return (
    <div style={page}>
      <header style={header}>
        <Pennant size={14} />
        <span style={brand}>Deepmarks</span>
      </header>

      <div style={body}>
        <h1 style={h1}>Enter your password</h1>
        <p style={lede}>This nsec is password-protected.</p>

        {npub && (
          <div style={npubCard}>
            <div style={npubLabel}>NPUB</div>
            <code style={npubCode}>{npub}</code>
          </div>
        )}

        {!recovering ? (
          <>
            <label style={uppercaseLabel}>password</label>
            <input
              type="password"
              autoFocus
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && password && !busy) void unlock(); }}
              style={input}
            />
            <button
              type="button"
              style={textButton}
              onClick={() => { setRecovering(true); setError(null); }}
            >
              forgot password? restore with nsec
            </button>
          </>
        ) : (
          <>
            <div style={warningRow}>
              <span style={warningPrefix}>!</span>
              <span style={warningText}>
                paste your backed-up nsec and set a new device password. this replaces the locked local copy.
                reconnect your NWC wallet afterward.
              </span>
            </div>

            <label style={uppercaseLabel}>recovery nsec</label>
            <textarea
              autoFocus
              autoComplete="off"
              value={recoveryNsec}
              onChange={(e) => setRecoveryNsec(e.target.value)}
              style={{ ...input, minHeight: 72, resize: 'vertical' }}
              placeholder="nsec1..."
            />

            <label style={uppercaseLabel}>new device password</label>
            <input
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              style={input}
              placeholder="at least 8 characters"
            />
            {recoveryPasswordTooShort && <div style={hintRow}>password must be at least 8 characters</div>}

            <label style={uppercaseLabel}>retype new password</label>
            <input
              type="password"
              autoComplete="new-password"
              value={newPasswordConfirm}
              onChange={(e) => setNewPasswordConfirm(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && canRecover && !busy) void recoverWithNsec(); }}
              style={input}
            />
            {recoveryPasswordMismatch && <div style={hintRow}>passwords don't match</div>}

            <button
              type="button"
              style={textButton}
              onClick={() => { setRecovering(false); setError(null); }}
            >
              use existing password instead
            </button>
          </>
        )}

        <div style={modeGroup}>
          <label style={modeRow}>
            <input
              type="radio"
              name="cache-mode"
              value="session"
              checked={mode === 'session'}
              onChange={() => setMode('session')}
            />
            <div>
              <div style={modeTitle}>Prompt when browser reopens</div>
              <div style={modeSub}>Stays unlocked only while this browser is open.</div>
            </div>
          </label>
          <label style={modeRow}>
            <input
              type="radio"
              name="cache-mode"
              value="days30"
              checked={mode === 'days30'}
              onChange={() => setMode('days30')}
            />
            <div>
              <div style={modeTitle}>Stay unlocked for 30 days</div>
              <div style={modeSub}>For trusted devices only. Lock now or sign out clears it.</div>
            </div>
          </label>
        </div>

        {error && <div style={errorRow}>{error}</div>}
      </div>

      <footer style={footer}>
        <button
          style={{
            ...primaryBtn,
            opacity: (recovering ? canRecover : password) && !busy ? 1 : 0.5,
            cursor: (recovering ? canRecover : password) && !busy ? 'pointer' : 'not-allowed',
          }}
          disabled={(recovering ? !canRecover : !password) || busy}
          onClick={() => void (recovering ? recoverWithNsec() : unlock())}
        >
          {busy ? (recovering ? 'Restoring…' : 'Unlocking…') : (recovering ? 'Restore account' : 'Unlock')}
        </button>
      </footer>
    </div>
  );
}

// ── Styles

const page: React.CSSProperties = {
  height: '100%', display: 'flex', flexDirection: 'column',
  background: colors.paper, color: colors.ink, fontFamily: fonts.sans,
};
const header: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: `${space.lg}px ${space.xl}px`,
  borderBottom: `1px solid ${colors.hairline}`,
};
const brand: React.CSSProperties = {
  fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.bodyMicro, fontWeight: 500, color: colors.accent,
};
const body: React.CSSProperties = {
  flex: 1, padding: `${space.xxl}px ${space.xxl}px ${space.xl}px`,
  overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: space.lg,
};
const h1: React.CSSProperties = {
  margin: 0, fontSize: fontSize.h1, lineHeight: lineHeight.h1,
  fontWeight: 500, letterSpacing: '-0.01em', color: colors.ink,
};
const lede: React.CSSProperties = {
  margin: 0, fontSize: fontSize.bodySmall, lineHeight: lineHeight.body, color: colors.inkSoft,
};
const npubCard: React.CSSProperties = {
  background: colors.paperAlt, border: `1px solid ${colors.hairline}`,
  borderRadius: radius.std, padding: space.lg,
};
const npubLabel: React.CSSProperties = {
  fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.uppercaseLabel, letterSpacing: '0.08em',
  color: colors.muted, marginBottom: 4,
};
const npubCode: React.CSSProperties = {
  display: 'block', fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.monoSmall, color: colors.inkSoft,
  wordBreak: 'break-all', lineHeight: lineHeight.body,
};
const uppercaseLabel: React.CSSProperties = {
  display: 'block', fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.uppercaseLabel, letterSpacing: '0.08em', fontWeight: 500,
  color: colors.muted, textTransform: 'uppercase', marginBottom: 4,
};
const input: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  padding: `${space.md}px ${space.lg}px`,
  border: `1px solid ${colors.hairline}`, borderRadius: radius.std,
  background: '#fff', color: colors.ink,
  fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.bodyMicro, outline: 'none',
};
const modeGroup: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: space.sm,
};
const modeRow: React.CSSProperties = {
  display: 'flex', alignItems: 'flex-start', gap: space.sm, cursor: 'pointer',
};
const modeTitle: React.CSSProperties = {
  fontSize: fontSize.bodySmall, color: colors.ink, lineHeight: lineHeight.body,
};
const modeSub: React.CSSProperties = {
  fontSize: fontSize.metaSmall, color: colors.muted, lineHeight: lineHeight.body,
};
const errorRow: React.CSSProperties = {
  padding: `${space.sm}px ${space.lg}px`, background: '#fbe9e3', color: '#8b2f17',
  borderRadius: radius.std, fontSize: fontSize.metaSmall,
};
const hintRow: React.CSSProperties = {
  fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.uppercaseLabel, color: colors.warn, marginTop: 4,
};
const textButton: React.CSSProperties = {
  alignSelf: 'flex-start',
  border: 'none',
  background: 'transparent',
  color: colors.accent,
  padding: 0,
  fontFamily: fonts.sans,
  fontSize: fontSize.bodySmall,
  cursor: 'pointer',
};
const warningRow: React.CSSProperties = {
  display: 'flex', gap: space.sm, alignItems: 'flex-start',
  fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.monoSmall, color: colors.warn,
};
const warningPrefix: React.CSSProperties = { fontWeight: 700 };
const warningText: React.CSSProperties = { lineHeight: 1.5 };
const footer: React.CSSProperties = {
  padding: `${space.lg}px ${space.xl}px`,
  borderTop: `1px solid ${colors.hairline}`,
  display: 'flex', justifyContent: 'flex-end',
};
const primaryBtn: React.CSSProperties = {
  padding: `${space.md}px ${space.xxl}px`,
  background: colors.ink, color: colors.paper,
  border: 'none', borderRadius: radius.std,
  fontFamily: fonts.sans, fontSize: fontSize.bodySmall, fontWeight: 500,
};
