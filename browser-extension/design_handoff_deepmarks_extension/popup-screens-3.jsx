// popup-screens-3.jsx — Sign-in request (NIP-07) and Settings page

function ScreenSignRequest({ onApprove, onReject }) {
  const [remember, setRemember] = React.useState('once');
  const site = 'stacker.news';
  return (
    <div className="dm-pop">
      <PopHeader title="sign-in request" right={<MenuDots />} />
      <div className="dm-body">

        <div style={{ marginTop: 4, marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: dm.muted, fontFamily: dm.mono, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>requested by</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 10, background: '#fff', border: `1px solid ${dm.hairline}`, borderRadius: 3 }}>
            <Favicon host={site} size={20} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>{site}</div>
              <div className="dm-mono" style={{ fontSize: 10.5, color: dm.muted }}>https://{site}/login</div>
            </div>
            <span className="dm-mono" style={{ fontSize: 10, color: dm.good, padding: '2px 6px', background: 'oklch(0.95 0.05 145)', borderRadius: 2, textTransform: 'uppercase', letterSpacing: '0.06em' }}>verified ssl</span>
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: dm.muted, fontFamily: dm.mono, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>action</div>
          <div style={{ padding: 10, background: dm.paperAlt, border: `1px solid ${dm.hairlineSoft}`, borderRadius: 3, fontSize: 12.5 }}>
            Sign a <span className="dm-mono" style={{ fontSize: 11, padding: '1px 5px', background: '#fff', borderRadius: 2 }}>kind:22242</span> auth event with your nostr key
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: dm.muted, fontFamily: dm.mono, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>event preview</div>
          <pre style={{
            margin: 0, padding: 10, fontSize: 10.5, fontFamily: dm.mono, color: dm.inkSoft,
            background: '#fff', border: `1px solid ${dm.hairline}`, borderRadius: 3, lineHeight: 1.55,
            overflow: 'hidden', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
          }}>
{`{
  "kind": 22242,
  "pubkey": "3bf0…1d7ae",
  "tags": [["relay","wss://relay.stacker.news"],
           ["challenge","a91f…"]],
  "content": ""
}`}
          </pre>
        </div>

        <div>
          <div style={{ fontSize: 11, color: dm.muted, fontFamily: dm.mono, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>remember decision</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {[
              ['once', 'Just this time'],
              ['session', 'Until I close the browser'],
              ['hour', 'For 1 hour'],
              ['forever', 'Forever — add to saved logins'],
            ].map(([v, l]) => (
              <label key={v} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', cursor: 'pointer', borderRadius: 3, background: remember === v ? dm.paperAlt : 'transparent', fontSize: 12.5 }}>
                <span style={{
                  width: 12, height: 12, borderRadius: '50%', border: `1px solid ${remember === v ? dm.ink : dm.hairline}`,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}>
                  {remember === v && <span style={{ width: 6, height: 6, borderRadius: '50%', background: dm.ink }} />}
                </span>
                <span>{l}</span>
                {v === 'forever' && <span className="dm-mono" style={{ fontSize: 10, color: dm.muted, marginLeft: 'auto' }}>★</span>}
              </label>
            ))}
          </div>
        </div>

      </div>
      <div className="dm-footer">
        <button className="dm-btn" onClick={onReject} style={{ flex: 1 }}>Reject</button>
        <button className="dm-btn dm-btn-primary" onClick={() => onApprove && onApprove(remember)} style={{ flex: 1 }}>Approve & sign</button>
      </div>
    </div>
  );
}

const SAVED_LOGINS = [
  { host: 'stacker.news', last: '2d ago' },
  { host: 'habla.news', last: '1w ago' },
  { host: 'zap.cooking', last: '3w ago' },
];

const RELAYS = [
  { url: 'wss://relay.damus.io', read: true, write: true },
  { url: 'wss://relay.nostr.band', read: true, write: true },
  { url: 'wss://nos.lol', read: true, write: true },
  { url: 'wss://relay.deepmarks.org', read: true, write: true },
];

function ScreenSettings({ onBack }) {
  const [tab, setTab] = React.useState('relays');
  const [defaultTags, setDefaultTags] = React.useState(['toread']);
  const [archiveDefault, setArchiveDefault] = React.useState(true);
  const [archiveOnlyOver, setArchiveOnlyOver] = React.useState(false);

  return (
    <div className="dm-pop" style={{ width: 720 }}>
      <PopHeader title="settings" right={
        <button className="dm-btn dm-btn-ghost" onClick={onBack} style={{ padding: '4px 8px', fontSize: 11 }}>← back</button>
      } npub="npub1jr…7ae" />
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <aside style={{ width: 160, padding: 14, borderRight: `1px solid ${dm.hairline}`, display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12.5 }}>
          {[
            ['relays', 'Relays'],
            ['archive', 'Archiving'],
            ['tags', 'Default tags'],
            ['logins', 'Saved logins'],
            ['account', 'Account'],
          ].map(([k, l]) => (
            <div key={k} onClick={() => setTab(k)} style={{
              padding: '6px 8px', borderRadius: 3, cursor: 'pointer',
              background: tab === k ? dm.paperAlt : 'transparent',
              color: tab === k ? dm.ink : dm.inkSoft, fontWeight: tab === k ? 500 : 400,
            }}>{l}</div>
          ))}
        </aside>
        <main style={{ flex: 1, padding: 18, overflowY: 'auto' }}>
          {tab === 'relays' && (
            <div>
              <h2 style={{ fontSize: 14, fontWeight: 500, margin: 0 }}>Relays</h2>
              <p style={{ fontSize: 12, color: dm.muted, marginTop: 4 }}>Where your bookmarks and signed events get published.</p>
              <div style={{ marginTop: 14, border: `1px solid ${dm.hairline}`, borderRadius: 3, background: '#fff' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 60px 60px 30px', padding: '8px 12px', fontSize: 10, color: dm.muted, fontFamily: dm.mono, textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: `1px solid ${dm.hairline}` }}>
                  <span>url</span><span>read</span><span>write</span><span></span>
                </div>
                {RELAYS.map((r, i) => (
                  <div key={r.url} style={{ display: 'grid', gridTemplateColumns: '1fr 60px 60px 30px', padding: '10px 12px', fontSize: 12, alignItems: 'center', borderBottom: i < RELAYS.length - 1 ? `1px solid ${dm.hairlineSoft}` : 'none' }}>
                    <span className="dm-mono" style={{ fontSize: 11.5 }}>{r.url}</span>
                    <span><div className={`dm-toggle ${r.read ? 'on' : ''}`} /></span>
                    <span><div className={`dm-toggle ${r.write ? 'on' : ''}`} /></span>
                    <span style={{ color: dm.muted, cursor: 'pointer', textAlign: 'right' }}>×</span>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <input className="dm-input dm-mono" placeholder="wss://…" style={{ flex: 1 }} />
                <button className="dm-btn">+ Add relay</button>
              </div>
            </div>
          )}
          {tab === 'archive' && (
            <div>
              <h2 style={{ fontSize: 14, fontWeight: 500, margin: 0 }}>Archiving</h2>
              <p style={{ fontSize: 12, color: dm.muted, marginTop: 4 }}>Snapshots are captured by the Deepmarks headless browser and stored on our archive node.</p>
              <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
                <Setting label="Archive new bookmarks by default" sub="The 'archive forever' toggle will be ON when you save.">
                  <div className={`dm-toggle ${archiveDefault ? 'on' : ''}`} onClick={() => setArchiveDefault(!archiveDefault)} />
                </Setting>
                <Setting label="Only archive pages over a paywall I have access to" sub="Reuses your browser cookies for the snapshot capture.">
                  <div className={`dm-toggle ${archiveOnlyOver ? 'on' : ''}`} onClick={() => setArchiveOnlyOver(!archiveOnlyOver)} />
                </Setting>
                <Setting label="Snapshot quality" sub="Higher quality = larger snapshots, slower capture.">
                  <select className="dm-input" style={{ width: 140, fontSize: 12 }} defaultValue="standard">
                    <option>fast</option>
                    <option>standard</option>
                    <option>archival</option>
                  </select>
                </Setting>
              </div>
              <div style={{ marginTop: 22, padding: 12, background: dm.paperAlt, borderRadius: 3, fontSize: 11.5, color: dm.inkSoft, border: `1px solid ${dm.hairlineSoft}` }}>
                <span className="dm-mono" style={{ color: dm.muted, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Storage</span>
                <div style={{ marginTop: 4 }}>248 snapshots · 412 MB · <span className="dm-link">manage →</span></div>
              </div>
            </div>
          )}
          {tab === 'tags' && (
            <div>
              <h2 style={{ fontSize: 14, fontWeight: 500, margin: 0 }}>Default tags</h2>
              <p style={{ fontSize: 12, color: dm.muted, marginTop: 4 }}>Applied to every new bookmark unless you remove them.</p>
              <div style={{ marginTop: 14 }}>
                <TagInput tags={defaultTags} setTags={setDefaultTags} suggestions={['toread', 'inbox', 'work', 'personal']} />
              </div>
            </div>
          )}
          {tab === 'logins' && (
            <div>
              <h2 style={{ fontSize: 14, fontWeight: 500, margin: 0 }}>Saved logins</h2>
              <p style={{ fontSize: 12, color: dm.muted, marginTop: 4 }}>Sites you've allowed to sign in with your nostr key without asking each time.</p>
              <div style={{ marginTop: 14, border: `1px solid ${dm.hairline}`, borderRadius: 3, background: '#fff' }}>
                {SAVED_LOGINS.map((s, i) => (
                  <div key={s.host} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderBottom: i < SAVED_LOGINS.length - 1 ? `1px solid ${dm.hairlineSoft}` : 'none' }}>
                    <Favicon host={s.host} size={16} />
                    <div style={{ flex: 1, fontSize: 12.5 }}>{s.host}</div>
                    <div className="dm-mono" style={{ fontSize: 11, color: dm.muted }}>last used {s.last}</div>
                    <button className="dm-btn dm-btn-ghost" style={{ fontSize: 11, padding: '4px 8px' }}>revoke</button>
                  </div>
                ))}
              </div>
            </div>
          )}
          {tab === 'account' && (
            <div>
              <h2 style={{ fontSize: 14, fontWeight: 500, margin: 0 }}>Account</h2>
              <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div>
                  <label className="dm-label">npub</label>
                  <input className="dm-input dm-mono" readOnly value="npub1jr0fk89aklq2v3qfh2dh68tqxv9k4r3kk7g8rh5hmqp9z0v3xvss7ae" />
                </div>
                <Setting label="Export bookmarks as JSON" sub="All your kind:39701 events, signed."><button className="dm-btn">Export</button></Setting>
                <Setting label="Sign out" sub="Removes your nsec from this device. Bookmarks stay on relays."><button className="dm-btn dm-btn-ghost" style={{ color: dm.accent }}>Sign out</button></Setting>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function Setting({ label, sub, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12.5, fontWeight: 500 }}>{label}</div>
        {sub && <div style={{ fontSize: 11, color: dm.muted, marginTop: 2 }}>{sub}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

Object.assign(window, { ScreenSignRequest, ScreenSettings });
