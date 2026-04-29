// Design tokens — single source of truth, lifted verbatim from
// design_handoff_deepmarks_extension/popup-base.jsx. The handoff README
// is explicit that this visual system is deliberate Pinboard-inspired
// utilitarian minimalism — don't improvise replacements.
//
// Don't edit these without an accompanying design change. The handoff
// directory is the spec.

export const colors = {
  paper:        '#fbfaf7',  // popup background, footer
  paperAlt:     '#f4f1e9',  // card panels, hover states
  ink:          '#1a1a1a',  // primary text, primary button
  inkSoft:      '#3d3a35',  // body copy
  muted:        '#827d72',  // labels, meta, mono receipts
  hairline:     '#e6e2d8',  // borders, dividers
  hairlineSoft: '#efece4',  // list row dividers
  // Accent: the more-muted oklch used everywhere except the logo itself.
  accent:       'oklch(0.55 0.15 25)',  // ≈ #c96442
  tagBg:        '#efeadd',
  good:         'oklch(0.55 0.13 145)', // success check, AUTOFILLED badge
  warn:         'oklch(0.6 0.13 70)',
  // Crayon-orange used ONLY by the pennant icon. Keep this exact shade.
  pennantOrange: '#ff6b5a',
} as const;

export const fonts = {
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  mono: 'ui-monospace, "JetBrains Mono", "SF Mono", Menlo, monospace',
} as const;

export const monoFeatures = '"ss01","tnum"';

// Type scale (px). Aliases match the README's mental model.
export const fontSize = {
  h1: 22,        // popup h1
  body: 14,
  bodySmall: 13,
  bodyMicro: 12.5,
  meta: 12,
  metaSmall: 11.5,
  micro: 11,
  monoSmall: 10.5,
  uppercaseLabel: 10,
} as const;

// Line heights from the README:
export const lineHeight = {
  h1: 1.15,
  title: 1.35,
  body: 1.45,
  paragraph: 1.55,
  prose: 1.7,
} as const;

// 8px base. Padding scale used by the handoff: 4 / 6 / 8 / 10 / 12 / 14 / 18 / 22.
export const space = {
  xxs: 4,
  xs: 6,
  sm: 8,
  md: 10,
  lg: 12,
  xl: 14,
  xxl: 18,
  xxxl: 22,
} as const;

export const radius = {
  // Cards / inputs / buttons / chips per the README.
  std: 3,
  // Pill toggle track (height 16, radius 9 makes the pill).
  pillTrack: 9,
  // Brand badge.
  badge: 2,
  // Popup outer container.
  popup: 6,
} as const;

// Popup outer container shadow (only place that has a shadow — every
// inner element is hairline-only).
export const popupShadow =
  '0 24px 60px -12px rgba(20,15,5,0.18), 0 8px 16px -8px rgba(20,15,5,0.12)';

// Production popup dimensions, fixed.
export const popupSize = {
  width: 400,
  height: 560,
} as const;

// Settings opens in its own tab at this width.
export const settingsWidth = 720;

// Uppercase label preset — used for things like "PRIVATE KEY", "REQUESTED BY", etc.
export const uppercaseLabel = {
  fontFamily: fonts.mono,
  fontFeatureSettings: monoFeatures,
  fontSize: fontSize.uppercaseLabel,
  letterSpacing: '0.08em',
  fontWeight: 500,
  color: colors.muted,
  textTransform: 'uppercase' as const,
};
