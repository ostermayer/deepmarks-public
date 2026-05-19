// popup-screens-2.jsx — Add bookmark form, Recent list

const SUGGESTED_TAGS = ['nostr', 'bitcoin', 'design', 'reading', 'longform', 'tools', 'rust', 'cypherpunk', 'tutorial', 'book'];

function ScreenAdd({ initial = {}, onSave, onClose }) {
  const url = initial.url || 'https://stacker.news/items/892341';
  const host = (url.match(/\/\/([^/]+)/) || [])[1] || '';
  const [title, setTitle] = React.useState(initial.title || 'How nostr relays handle censorship in practice');
  const [desc, setDesc] = React.useState(initial.desc || 'Long discussion thread on relay-level moderation, paid relays and the difference between protocol-level and policy-level filtering.');
  const [tags, setTags] = React.useState(initial.tags || ['nostr', 'relays']);
  const [archive, setArchive] = React.useState(true);
  const [autofilled, setAutofilled] = React.useState(true);

  return (
    <div className="dm-pop">
      <PopHeader title="add bookmark" right={<MenuDots />} npub="npub1jr…7ae" />
      <div className="dm-body">

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 10px', background: dm.paperAlt, borderRadius: 3, marginBottom: 14, border: `1px solid ${dm.hairlineSoft}` }}>
          <Favicon host={host} size={16} />
          <span className="dm-mono" style={{ fontSize: 11, color: dm.inkSoft, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{url}</span>
          {autofilled && <span className="dm-mono" style={{ fontSize: 9, color: dm.good, letterSpacing: '0.08em', textTransform: 'uppercase' }}>autofilled</span>}
        </div>

        <div style={{ marginBottom: 12 }}>
          <label className="dm-label">title</label>
          <input className="dm-input" value={title} onChange={e => { setTitle(e.target.value); setAutofilled(false); }} />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label className="dm-label">description</label>
          <textarea className="dm-input dm-textarea" value={desc} onChange={e => setDesc(e.target.value)} />
        </div>

        <div style={{ marginBottom: 8 }}>
          <label className="dm-label">tags</label>
          <TagInput tags={tags} setTags={setTags} suggestions={SUGGESTED_TAGS} />
        </div>

      </div>
      <div className="dm-footer" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10, padding: '10px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div className={`dm-toggle ${archive ? 'on' : ''}`} onClick={() => setArchive(!archive)} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 500 }}>Archive forever</div>
            <div style={{ fontSize: 10.5, color: dm.muted }}>Snapshot stored on deepmarks archive node</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="dm-btn" onClick={onClose} style={{ flex: 0 }}>Cancel</button>
          <button className="dm-btn dm-btn-primary" onClick={() => onSave && onSave({ title, desc, tags, archive })} style={{ flex: 1 }}>
            Save bookmark <span className="dm-kbd" style={{ marginLeft: 6, background: 'rgba(255,255,255,0.12)', borderColor: 'rgba(255,255,255,0.18)', color: 'rgba(255,255,255,0.7)' }}>⏎</span>
          </button>
        </div>
      </div>
    </div>
  );
}

const RECENT_BOOKMARKS = [
  { host: 'fiatjaf.com', title: 'A modest proposal for nostr relays', tags: ['nostr', 'longform'], time: '2m', archived: true },
  { host: 'stacker.news', title: 'How nostr relays handle censorship in practice', tags: ['nostr', 'relays'], time: '14m', archived: true },
  { host: 'github.com', title: 'nostr-protocol / nips · NIP-B0 Web Bookmarking', tags: ['nostr', 'spec'], time: '1h', archived: false },
  { host: 'maciej.ceglowski.com', title: 'The internet with a human face', tags: ['reading', 'web'], time: '3h', archived: true },
  { host: 'pinboard.in', title: 'Pinboard FAQ — why no JavaScript', tags: ['reference'], time: 'yesterday', archived: false },
  { host: 'nostr.how', title: 'NIP-07 browser extensions explained', tags: ['nostr', 'tutorial'], time: 'yesterday', archived: true },
  { host: 'lobste.rs', title: 'Self-hosting a nostr relay on a $5 VPS', tags: ['nostr', 'sysadmin'], time: '2d', archived: true },
];

function ScreenRecent({ onAdd, onSettings }) {
  const [tab, setTab] = React.useState('mine');
  const [q, setQ] = React.useState('');
  const filtered = RECENT_BOOKMARKS.filter(b =>
    !q || b.title.toLowerCase().includes(q.toLowerCase()) || b.tags.some(t => t.includes(q.toLowerCase()))
  );
  return (
    <div className="dm-pop">
      <PopHeader title="recent" right={
        <div style={{ display: 'flex', gap: 4 }}>
          <button className="dm-btn dm-btn-ghost" style={{ padding: '4px 6px', fontSize: 11 }} onClick={onSettings}>settings</button>
        </div>
      } npub="npub1jr…7ae" />
      <div style={{ padding: '10px 14px 0', flexShrink: 0 }}>
        <input className="dm-input" placeholder="filter by title or #tag" value={q} onChange={e => setQ(e.target.value)} style={{ fontSize: 12 }} />
        <div style={{ display: 'flex', marginTop: 10, borderBottom: `1px solid ${dm.hairline}` }}>
          {['mine', 'tags', 'archived'].map(t => (
            <span key={t} className={`dm-tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>{t}</span>
          ))}
          <div style={{ flex: 1 }} />
          <span className="dm-mono" style={{ fontSize: 10, color: dm.muted, alignSelf: 'center' }}>{filtered.length} of 248</span>
        </div>
      </div>
      <div className="dm-body" style={{ paddingTop: 4 }}>
        {filtered.map((b, i) => (
          <div key={i} className="dm-list-row">
            <div style={{ paddingTop: 2 }}><Favicon host={b.host} size={14} /></div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 500, lineHeight: 1.35, marginBottom: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.title}</div>
              <div className="dm-mono" style={{ fontSize: 10.5, color: dm.muted, marginBottom: 5 }}>
                {b.host} · {b.time}{b.archived ? ' · archived' : ''}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                {b.tags.map(t => <span key={t} className="dm-chip" style={{ height: 18, padding: '0 5px', fontSize: 10.5 }}>{t}</span>)}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="dm-footer">
        <button className="dm-btn dm-btn-primary" onClick={onAdd} style={{ flex: 1 }}>+ Bookmark this page <span className="dm-kbd" style={{ marginLeft: 6, background: 'rgba(255,255,255,0.12)', borderColor: 'rgba(255,255,255,0.18)', color: 'rgba(255,255,255,0.7)' }}>⌘D</span></button>
      </div>
    </div>
  );
}

Object.assign(window, { ScreenAdd, ScreenRecent });
