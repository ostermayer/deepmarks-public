// popup-base.jsx — Tokens, shared CSS, header, favicon, tag chip input.

const POPUP_W = 400;
const POPUP_H = 560;

const dm = {
  paper: '#fbfaf7',
  paperAlt: '#f4f1e9',
  ink: '#1a1a1a',
  inkSoft: '#3d3a35',
  muted: '#827d72',
  hairline: '#e6e2d8',
  hairlineSoft: '#efece4',
  accent: 'oklch(0.55 0.15 25)',
  accentBg: 'oklch(0.95 0.04 25)',
  tagBg: '#efeadd',
  good: 'oklch(0.55 0.13 145)',
  warn: 'oklch(0.6 0.13 70)',
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  mono: 'ui-monospace, "JetBrains Mono", "SF Mono", Menlo, monospace',
};

if (typeof document !== 'undefined' && !document.getElementById('dm-popup-styles')) {
  const s = document.createElement('style');
  s.id = 'dm-popup-styles';
  s.textContent = `
    .dm-pop { font-family: ${dm.sans}; color: ${dm.ink}; background: ${dm.paper}; width: ${POPUP_W}px; height: ${POPUP_H}px; display: flex; flex-direction: column; font-size: 13px; line-height: 1.45; overflow: hidden; position: relative; }
    .dm-pop * { box-sizing: border-box; }
    .dm-mono { font-family: ${dm.mono}; font-feature-settings: "ss01","tnum"; }
    .dm-link { color: ${dm.accent}; text-decoration: none; cursor: pointer; }
    .dm-link:hover { text-decoration: underline; }
    .dm-btn { font-family: inherit; font-size: 12px; padding: 7px 12px; border: 1px solid ${dm.hairline}; background: #fff; color: ${dm.ink}; border-radius: 3px; cursor: pointer; line-height: 1; transition: border-color .12s, background .12s; }
    .dm-btn:hover { border-color: ${dm.muted}; }
    .dm-btn-primary { background: ${dm.ink}; color: #fff; border-color: ${dm.ink}; }
    .dm-btn-primary:hover { background: #000; }
    .dm-btn-ghost { border-color: transparent; background: transparent; color: ${dm.muted}; }
    .dm-btn-ghost:hover { background: ${dm.paperAlt}; color: ${dm.ink}; border-color: transparent; }
    .dm-input { font-family: inherit; font-size: 13px; padding: 7px 9px; border: 1px solid ${dm.hairline}; background: #fff; color: ${dm.ink}; border-radius: 3px; width: 100%; line-height: 1.3; }
    .dm-input:focus { outline: none; border-color: ${dm.ink}; }
    .dm-input.dm-mono { font-size: 12px; letter-spacing: -0.01em; }
    .dm-textarea { resize: none; min-height: 56px; }
    .dm-label { font-size: 10px; color: ${dm.muted}; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 5px; display: block; font-weight: 500; }
    .dm-chip { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 7px; background: ${dm.tagBg}; color: ${dm.inkSoft}; border-radius: 2px; font-size: 12px; font-family: ${dm.mono}; cursor: default; }
    .dm-chip-x { cursor: pointer; opacity: 0.5; font-size: 11px; line-height: 1; }
    .dm-chip-x:hover { opacity: 1; color: ${dm.accent}; }
    .dm-chip-suggest { background: transparent; border: 1px dashed ${dm.hairline}; color: ${dm.muted}; cursor: pointer; }
    .dm-chip-suggest:hover { background: ${dm.tagBg}; color: ${dm.inkSoft}; border-color: ${dm.tagBg}; }
    .dm-row { display: flex; align-items: center; gap: 8px; }
    .dm-toggle { position: relative; width: 28px; height: 16px; background: ${dm.hairline}; border-radius: 9px; cursor: pointer; transition: background .15s; flex-shrink: 0; }
    .dm-toggle.on { background: ${dm.ink}; }
    .dm-toggle::after { content: ''; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; background: #fff; border-radius: 50%; transition: transform .15s; }
    .dm-toggle.on::after { transform: translateX(12px); }
    .dm-divider { height: 1px; background: ${dm.hairline}; }
    .dm-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid ${dm.hairline}; flex-shrink: 0; }
    .dm-brand { font-family: ${dm.mono}; font-size: 13px; font-weight: 600; letter-spacing: -0.02em; }
    .dm-brand-dot { color: ${dm.accent}; }
    .dm-body { flex: 1; overflow-y: auto; padding: 14px; }
    .dm-footer { padding: 10px 14px; border-top: 1px solid ${dm.hairline}; flex-shrink: 0; background: ${dm.paper}; display: flex; gap: 8px; align-items: center; }
    .dm-kbd { font-family: ${dm.mono}; font-size: 10px; padding: 1px 5px; background: #fff; border: 1px solid ${dm.hairline}; border-radius: 2px; color: ${dm.muted}; }
    .dm-pop ::-webkit-scrollbar { width: 4px; }
    .dm-pop ::-webkit-scrollbar-thumb { background: ${dm.hairline}; border-radius: 2px; }
    .dm-list-row { display: flex; gap: 10px; padding: 10px 0; border-bottom: 1px solid ${dm.hairlineSoft}; }
    .dm-list-row:last-child { border-bottom: none; }
    .dm-tab { padding: 6px 0; margin-right: 16px; font-size: 12px; color: ${dm.muted}; border-bottom: 2px solid transparent; cursor: pointer; }
    .dm-tab.active { color: ${dm.ink}; border-bottom-color: ${dm.ink}; }
  `;
  document.head.appendChild(s);
}

function Pennant({ size = 14, color }) {
  const c = color || dm.accent;
  // Pixel-art pennant flag traced from pennant.svg, on a 32-unit grid.
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" shapeRendering="crispEdges" style={{ flexShrink: 0, display: 'block' }}>
      <rect x="8" y="4" width="2" height="24" fill={c} />
      <rect x="10" y="6" width="4" height="2" fill={c} />
      <rect x="10" y="8" width="8" height="2" fill={c} />
      <rect x="10" y="10" width="12" height="2" fill={c} />
      <rect x="10" y="12" width="14" height="2" fill={c} />
      <rect x="10" y="14" width="12" height="2" fill={c} />
      <rect x="10" y="16" width="8" height="2" fill={c} />
      <rect x="10" y="18" width="4" height="2" fill={c} />
    </svg>
  );
}

function PopHeader({ title, right, npub }) {
  return (
    <div className="dm-header">
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <Pennant size={14} />
        <span className="dm-brand" style={{ color: dm.accent }}>deepmarks.org</span>
        {title && <span style={{ color: dm.muted, fontSize: 12 }}>· {title}</span>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {npub && <span className="dm-mono" style={{ fontSize: 11, color: dm.muted }}>{npub}</span>}
        {right}
      </div>
    </div>
  );
}

function Favicon({ host, size = 14 }) {
  const hue = (host || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  const letter = (host || '?').replace(/^www\./, '')[0]?.toUpperCase() || '?';
  return (
    <span style={{
      width: size, height: size, borderRadius: 3, flexShrink: 0,
      background: `oklch(0.88 0.06 ${hue})`, color: `oklch(0.32 0.1 ${hue})`,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.62, fontWeight: 600, fontFamily: dm.sans,
    }}>{letter}</span>
  );
}

function MenuDots({ onClick }) {
  return (
    <button onClick={onClick} aria-label="menu" style={{
      background: 'transparent', border: 'none', cursor: 'pointer', padding: 4,
      color: dm.muted, fontSize: 14, lineHeight: 1, fontFamily: dm.mono,
    }}>···</button>
  );
}

function TagInput({ tags, setTags, suggestions = [] }) {
  const [val, setVal] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const inputRef = React.useRef(null);
  const filtered = suggestions
    .filter(s => !tags.includes(s) && (val ? s.toLowerCase().includes(val.toLowerCase()) : true))
    .slice(0, 6);

  const add = (t) => {
    const clean = t.trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-');
    if (!clean || tags.includes(clean)) return;
    setTags([...tags, clean]);
    setVal('');
  };
  const onKey = (e) => {
    if ((e.key === 'Enter' || e.key === ',' || e.key === ' ') && val.trim()) {
      e.preventDefault();
      add(val);
    } else if (e.key === 'Backspace' && !val && tags.length) {
      setTags(tags.slice(0, -1));
    }
  };
  return (
    <div>
      <div onClick={() => inputRef.current?.focus()} style={{
        display: 'flex', flexWrap: 'wrap', gap: 4, padding: 5,
        border: `1px solid ${dm.hairline}`, background: '#fff', borderRadius: 3, minHeight: 34, cursor: 'text',
      }}>
        {tags.map(t => (
          <span key={t} className="dm-chip">
            {t}
            <span className="dm-chip-x" onClick={(e) => { e.stopPropagation(); setTags(tags.filter(x => x !== t)); }}>×</span>
          </span>
        ))}
        <input
          ref={inputRef}
          value={val}
          placeholder={tags.length ? '' : 'add tag…'}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={onKey}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          style={{
            border: 'none', outline: 'none', background: 'transparent',
            fontFamily: dm.mono, fontSize: 12, flex: 1, minWidth: 60, padding: '3px 4px',
          }}
        />
      </div>
      {open && filtered.length > 0 && (
        <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          <span style={{ fontSize: 10, color: dm.muted, alignSelf: 'center', marginRight: 2, textTransform: 'uppercase', letterSpacing: '0.06em' }}>recent</span>
          {filtered.map(s => (
            <span key={s} className="dm-chip dm-chip-suggest" onMouseDown={(e) => { e.preventDefault(); add(s); }}>+ {s}</span>
          ))}
        </div>
      )}
    </div>
  );
}

Object.assign(window, { POPUP_W, POPUP_H, dm, Pennant, PopHeader, Favicon, MenuDots, TagInput });
