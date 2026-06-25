// Tag chip input — pixel-matches popup-base.jsx's `TagInput`.
//
// Behavior (per design handoff):
// - Typing + Enter / `,` / space commits the current draft as a tag chip
// - Tags normalized: lowercased, leading `#` stripped, internal whitespace → `-`
// - Backspace on empty input removes the last chip
// - Suggestion chips appear below labeled `RECENT` when input is focused
//   and not empty; clicking adds. Filtered by current draft. Dedup'd.
// - Already-present tags are filtered out of suggestions

import { useMemo, useRef, useState } from 'react';
import { colors, fonts, fontSize, radius, space } from '../../shared/tokens.js';

export interface TagInputProps {
  value: string[];
  onChange: (next: string[]) => void;
  /** Recent tags from the user's history; surfaced as suggestion chips. */
  suggestions?: string[];
  placeholder?: string;
}

export function TagInput({ value, onChange, suggestions = [], placeholder = 'add tags…' }: TagInputProps) {
  const [draft, setDraft] = useState('');
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function commit(raw: string) {
    const norm = normalize(raw);
    if (!norm) return;
    if (value.includes(norm)) return;
    onChange([...value, norm]);
    setDraft('');
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',' || (e.key === ' ' && draft.length > 0)) {
      e.preventDefault();
      commit(draft);
      return;
    }
    if (e.key === 'Backspace' && draft === '' && value.length > 0) {
      e.preventDefault();
      onChange(value.slice(0, -1));
    }
  }

  const filteredSuggestions = useMemo(() => {
    const q = normalize(draft);
    return suggestions
      .filter((s) => !value.includes(s))
      .filter((s) => !q || s.includes(q))
      .slice(0, 8);
  }, [draft, value, suggestions]);

  return (
    <div>
      <div
        style={{
          ...inputBox,
          borderColor: focused ? colors.ink : colors.hairline,
        }}
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((t) => (
          <span key={t} style={chip}>
            #{t}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onChange(value.filter((x) => x !== t)); }}
              style={chipX}
              aria-label={`remove tag ${t}`}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          placeholder={value.length === 0 ? placeholder : ''}
          style={input}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
      </div>

      {focused && filteredSuggestions.length > 0 && (
        <div style={suggestionsBox}>
          <span style={suggestionsLabel}>RECENT</span>
          {filteredSuggestions.map((s) => (
            <button
              key={s}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); commit(s); }}
              style={suggestionChip}
            >
              #{s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Lowercase, strip leading `#`, collapse internal whitespace to `-`. */
function normalize(raw: string): string {
  return raw.trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-');
}

// ── Styles

const inputBox: React.CSSProperties = {
  display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4,
  padding: `${space.xs}px ${space.sm}px`,
  border: `1px solid ${colors.hairline}`,
  borderRadius: radius.std,
  background: '#fff',
  cursor: 'text',
  minHeight: 30,
};
const chip: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 2,
  fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.monoSmall,
  padding: '2px 4px 2px 6px',
  background: colors.tagBg, color: colors.inkSoft,
  borderRadius: radius.badge,
  height: 18, lineHeight: '14px',
};
const chipX: React.CSSProperties = {
  background: 'transparent', border: 'none', cursor: 'pointer',
  color: colors.muted, padding: '0 2px', fontSize: 12, lineHeight: 1,
};
const input: React.CSSProperties = {
  flex: 1, minWidth: 80,
  border: 'none', outline: 'none', background: 'transparent',
  fontFamily: fonts.sans, fontSize: fontSize.bodyMicro,
  color: colors.ink,
};
const suggestionsBox: React.CSSProperties = {
  display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4,
  marginTop: space.xs,
};
const suggestionsLabel: React.CSSProperties = {
  fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.uppercaseLabel, letterSpacing: '0.08em',
  fontWeight: 500, color: colors.muted, textTransform: 'uppercase',
  marginRight: 4,
};
const suggestionChip: React.CSSProperties = {
  fontFamily: fonts.mono, fontFeatureSettings: '"ss01","tnum"',
  fontSize: fontSize.monoSmall,
  padding: '2px 6px',
  background: 'transparent', border: `1px dashed ${colors.hairline}`,
  color: colors.muted,
  borderRadius: radius.badge, cursor: 'pointer',
  height: 18, lineHeight: '14px',
};
