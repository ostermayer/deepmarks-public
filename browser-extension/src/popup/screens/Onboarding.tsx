// Onboarding (first run) — pixel-matches design_handoff_deepmarks_extension/
// popup-screens-1.jsx ScreenOnboarding.
//
// Header → body (h1 + subtitle, three numbered bullets, "new to nostr?"
// sand panel) → footer (full-width primary button → Login).

import { colors, fonts, fontSize, lineHeight, space, radius } from '../../shared/tokens.js';
import { Pennant } from '../../shared/Pennant.js';
import { navigate } from '../router.js';

export function Onboarding() {
  return (
    <div style={page}>
      <header style={header}>
        <Pennant size={14} />
        <span style={brand}>Deepmarks</span>
      </header>

      <div style={body}>
        <h1 style={h1}>Bookmarks you own.</h1>
        <p style={lede}>
          Save any page to Nostr. They live on relays you choose, signed by your key.
        </p>

        <ol style={bullets}>
          <Bullet n="01" text="Your nsec stays on this device. We never see it." />
          <Bullet n="02" text="One click saves the current page; tags + archive optional." />
          <Bullet n="03" text="Works as a NIP-07 signer on any Nostr-enabled site." />
        </ol>

        <div style={sandPanel}>
          <div style={sandLabel}>NEW TO DEEPMARKS?</div>
          <p style={sandBody}>
            You'll need a private key (an <code style={mono}>nsec1…</code>). Don't have one?
            We'll generate one for you on the next screen.
          </p>
        </div>
      </div>

      <footer style={footer}>
        <button style={primaryBtn} onClick={() => navigate('login')}>Sign in with nsec</button>
      </footer>
    </div>
  );
}

function Bullet({ n, text }: { n: string; text: string }) {
  return (
    <li style={bulletLi}>
      <span style={bulletNum}>{n}</span>
      <span style={bulletText}>{text}</span>
    </li>
  );
}

// ── Styles (object form because CSS Modules in extension popups is
// extra config; inline keeps the design tokens easy to grep).

const page: React.CSSProperties = {
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  background: colors.paper,
  color: colors.ink,
  fontFamily: fonts.sans,
};

const header: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: `${space.lg}px ${space.xl}px`,
  borderBottom: `1px solid ${colors.hairline}`,
  background: colors.paper,
};

const brand: React.CSSProperties = {
  fontFamily: fonts.mono,
  fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.bodyMicro,
  fontWeight: 500,
  color: colors.accent,
  letterSpacing: '0.02em',
};

const body: React.CSSProperties = {
  flex: 1,
  padding: `${space.xxl}px ${space.xxl}px ${space.xl}px`,
  overflowY: 'auto',
};

const h1: React.CSSProperties = {
  margin: `0 0 ${space.md}px`,
  fontSize: fontSize.h1,
  lineHeight: lineHeight.h1,
  fontWeight: 500,
  letterSpacing: '-0.01em',
  color: colors.ink,
};

const lede: React.CSSProperties = {
  margin: `0 0 ${space.xl}px`,
  fontSize: fontSize.bodySmall,
  lineHeight: lineHeight.body,
  color: colors.inkSoft,
};

const bullets: React.CSSProperties = {
  listStyle: 'none',
  padding: 0,
  margin: `0 0 ${space.xl}px`,
  display: 'flex',
  flexDirection: 'column',
  gap: space.lg,
};

const bulletLi: React.CSSProperties = {
  display: 'flex',
  gap: space.lg,
  alignItems: 'baseline',
};

const bulletNum: React.CSSProperties = {
  fontFamily: fonts.mono,
  fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.metaSmall,
  color: colors.accent,
  letterSpacing: '0.02em',
  flexShrink: 0,
};

const bulletText: React.CSSProperties = {
  fontSize: fontSize.bodySmall,
  lineHeight: lineHeight.body,
  color: colors.inkSoft,
};

const sandPanel: React.CSSProperties = {
  background: colors.paperAlt,
  border: `1px solid ${colors.hairline}`,
  borderRadius: radius.std,
  padding: `${space.lg}px ${space.xl}px`,
};

const sandLabel: React.CSSProperties = {
  fontFamily: fonts.mono,
  fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.uppercaseLabel,
  letterSpacing: '0.08em',
  fontWeight: 500,
  color: colors.muted,
  marginBottom: space.xs,
};

const sandBody: React.CSSProperties = {
  margin: 0,
  fontSize: fontSize.metaSmall,
  lineHeight: lineHeight.body,
  color: colors.inkSoft,
};

const mono: React.CSSProperties = {
  fontFamily: fonts.mono,
  fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.metaSmall,
};

const footer: React.CSSProperties = {
  padding: `${space.lg}px ${space.xl}px ${space.xl}px`,
  borderTop: `1px solid ${colors.hairline}`,
  background: colors.paper,
};

const primaryBtn: React.CSSProperties = {
  width: '100%',
  padding: `${space.lg}px`,
  background: colors.ink,
  color: colors.paper,
  border: 'none',
  borderRadius: radius.std,
  fontFamily: fonts.sans,
  fontSize: fontSize.body,
  fontWeight: 500,
  cursor: 'pointer',
};
