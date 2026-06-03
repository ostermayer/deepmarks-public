// Set-password screen — used to migrate legacy plaintext accounts to
// encrypted-at-rest storage. New Login writes encrypted records directly.

import { useState } from 'react';
import { colors, fonts, fontSize, lineHeight, space, radius } from '../../shared/tokens.js';
import { Pennant } from '../../shared/Pennant.js';
import {
  getCachedAccountEncryptionKey,
  nsecStore,
  type NsecState,
  type CacheMode,
} from '../../lib/nsec-store.js';
import { migrateNwcToEncrypted } from '../../lib/nwc-store.js';

export function SetPassword({ onDone }: { onDone: (state: NsecState) => void }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [mode, setMode] = useState<CacheMode>('session');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tooShort = pw.length > 0 && pw.length < 8;
  const mismatch = pw2.length > 0 && pw !== pw2;
  const valid = pw.length >= 8 && pw === pw2;

  async function setPassword() {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const next = await nsecStore.setPassword(pw, mode);
      const key = await getCachedAccountEncryptionKey();
      if (key) await migrateNwcToEncrypted(key);
      void chrome.runtime.sendMessage({ kind: 'archive-backfill-run' }).catch(() => undefined);
      onDone(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={page}>
      <header style={header}>
        <Pennant size={14} />
        <span style={brand}>Deepmarks</span>
      </header>

      <div style={body}>
        <h1 style={h1}>Add a password</h1>
        <p style={lede}>
          Encrypts your recovery key on this device. You'll use this password
          when the extension needs to unlock after the browser reopens.
        </p>

        <label style={uppercaseLabel}>password</label>
        <input
          type="password"
          autoFocus
          autoComplete="new-password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          style={input}
          placeholder="at least 8 characters"
        />
        {tooShort && <div style={hintRow}>password must be at least 8 characters</div>}

        <label style={uppercaseLabel}>retype password</label>
        <input
          type="password"
          autoComplete="new-password"
          value={pw2}
          onChange={(e) => setPw2(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && valid && !busy) void setPassword(); }}
          style={input}
        />
        {mismatch && <div style={hintRow}>passwords don't match</div>}

        <div style={modeGroup}>
          <label style={modeRow}>
            <input
              type="radio"
              name="cache-mode"
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
              checked={mode === 'days30'}
              onChange={() => setMode('days30')}
            />
            <div>
              <div style={modeTitle}>Stay unlocked for 30 days</div>
              <div style={modeSub}>For trusted devices only. Lock now or sign out clears it.</div>
            </div>
          </label>
        </div>

        <div style={warningRow}>
          <span style={warningPrefix}>!</span>
          <span style={warningText}>
            if you forget your password, you'll need to re-enter your nsec
            from your backup. there's no recovery on this device.
          </span>
        </div>

        {error && <div style={errorRow}>{error}</div>}
      </div>

      <footer style={footer}>
        <button
          type="button"
          style={{ ...primaryBtn, opacity: valid && !busy ? 1 : 0.5, cursor: valid && !busy ? 'pointer' : 'not-allowed' }}
          disabled={!valid || busy}
          onClick={() => void setPassword()}
        >
          {busy ? 'Setting…' : 'Set password'}
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
  overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: space.md,
};
const h1: React.CSSProperties = {
  margin: 0, fontSize: fontSize.h1, lineHeight: lineHeight.h1,
  fontWeight: 500, letterSpacing: '-0.01em', color: colors.ink,
};
const lede: React.CSSProperties = {
  margin: `0 0 ${space.sm}px`, fontSize: fontSize.bodySmall,
  lineHeight: lineHeight.body, color: colors.inkSoft,
};
const uppercaseLabel: React.CSSProperties = {
  display: 'block', fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.uppercaseLabel, letterSpacing: '0.08em', fontWeight: 500,
  color: colors.muted, textTransform: 'uppercase', marginBottom: 4, marginTop: space.sm,
};
const input: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  padding: `${space.md}px ${space.lg}px`,
  border: `1px solid ${colors.hairline}`, borderRadius: radius.std,
  background: '#fff', color: colors.ink,
  fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.bodyMicro, outline: 'none',
};
const hintRow: React.CSSProperties = {
  fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.uppercaseLabel, color: colors.warn, marginTop: 4,
};
const modeGroup: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: space.sm,
  marginTop: space.sm,
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
const warningRow: React.CSSProperties = {
  display: 'flex', gap: space.sm, alignItems: 'flex-start',
  fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.monoSmall, color: colors.warn,
  marginTop: space.sm,
};
const warningPrefix: React.CSSProperties = { fontWeight: 700 };
const warningText: React.CSSProperties = { lineHeight: 1.5 };
const errorRow: React.CSSProperties = {
  padding: `${space.sm}px ${space.lg}px`, background: '#fbe9e3', color: '#8b2f17',
  borderRadius: radius.std, fontSize: fontSize.metaSmall,
};
const footer: React.CSSProperties = {
  padding: `${space.lg}px ${space.xl}px`,
  borderTop: `1px solid ${colors.hairline}`,
  display: 'flex', justifyContent: 'flex-end', gap: space.lg,
};
const primaryBtn: React.CSSProperties = {
  padding: `${space.md}px ${space.xxl}px`,
  background: colors.ink, color: colors.paper,
  border: 'none', borderRadius: radius.std,
  fontFamily: fonts.sans, fontSize: fontSize.bodySmall, fontWeight: 500,
};
