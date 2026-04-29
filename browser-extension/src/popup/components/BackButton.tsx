// Header back button. Renders only when the router has somewhere to
// go back to — at the root (Recent) it's invisible, so the header
// keeps a stable "brand on the left" feel until you've drilled in.

import { back, canGoBack } from '../router.js';
import { colors, fonts, fontSize, radius, space } from '../../shared/tokens.js';

export function BackButton({ label = 'back' }: { label?: string }) {
  if (!canGoBack()) return null;
  return (
    <button type="button" onClick={() => back()} style={style} aria-label="Go back">
      <span aria-hidden="true" style={arrow}>←</span>
      <span>{label}</span>
    </button>
  );
}

const style: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: `${space.xs}px ${space.sm}px`,
  background: 'transparent', border: 'none',
  color: colors.muted, fontFamily: fonts.sans, fontSize: fontSize.metaSmall,
  cursor: 'pointer', borderRadius: radius.std,
  marginRight: space.sm,
};
const arrow: React.CSSProperties = {
  fontSize: fontSize.body, lineHeight: 1, color: colors.muted,
};
