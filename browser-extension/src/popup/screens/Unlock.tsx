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
import { nip19 } from 'nostr-tools';

export function Unlock({ state, onUnlocked }: {
  state: NsecState;
  onUnlocked: (s: NsecState) => void;
}) {
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<CacheMode>('session');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function unlock() {
    setError(null);
    setBusy(true);
    try {
      const next = await nsecStore.unlock(password, mode);
      onUnlocked(next);
    } catch (e) {
      setError((e as Error).message ?? 'wrong password');
      setPassword('');
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
              <div style={modeSub}>Most secure. Stays unlocked while this browser is open.</div>
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
              <div style={modeTitle}>Remember for 30 days</div>
              <div style={modeSub}>More convenient. Re-prompts after 30 days of inactivity.</div>
            </div>
          </label>
        </div>

        {error && <div style={errorRow}>{error}</div>}
      </div>

      <footer style={footer}>
        <button
          style={{ ...primaryBtn, opacity: password && !busy ? 1 : 0.5, cursor: password && !busy ? 'pointer' : 'not-allowed' }}
          disabled={!password || busy}
          onClick={() => void unlock()}
        >
          {busy ? 'Unlocking…' : 'Unlock'}
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
