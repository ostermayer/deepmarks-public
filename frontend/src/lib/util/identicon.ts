// Deterministic identicon helpers — derive a stable color + initial from a
// pubkey hex so users always get the SAME avatar for a given identity, but
// nobody ever sees a stranger's real photo (which is what pravatar.cc was
// silently doing in the placeholder UI).

/** Hex pubkey → HSL background color. Pure: same input → same output. */
export function colorFromPubkey(pubkey: string): string {
  if (!/^[0-9a-f]{4,}$/i.test(pubkey)) {
    // Defensive — degrade rather than throw on garbage; default coral.
    return 'hsl(8 100% 67%)';
  }
  // First 2 hex chars (1 byte) → hue 0–359.
  const hue = Math.round((parseInt(pubkey.slice(0, 2), 16) / 256) * 360);
  // 3rd char → saturation 50–80%, 4th → lightness 40–55%. Keeps text legible.
  const sat = 50 + Math.round((parseInt(pubkey.slice(2, 3), 16) / 16) * 30);
  const light = 40 + Math.round((parseInt(pubkey.slice(3, 4), 16) / 16) * 15);
  return `hsl(${hue} ${sat}% ${light}%)`;
}

/**
 * One-character glyph for the identicon. Order of preference:
 *   1. first letter of supplied display/name (uppercased)
 *   2. first non-prefix letter of the npub (after `npub1`)
 *   3. "?" — only if both inputs are empty
 */
export function initialFor(displayName: string | undefined, npub: string | undefined): string {
  const name = (displayName ?? '').trim();
  if (name.length > 0) return name.charAt(0).toUpperCase();
  if (npub && npub.startsWith('npub1') && npub.length > 5) {
    return npub.charAt(5).toUpperCase();
  }
  return '?';
}
