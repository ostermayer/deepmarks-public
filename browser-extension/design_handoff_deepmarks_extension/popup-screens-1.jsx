// popup-screens-1.jsx — Onboarding, Login, Saved confirmation

function ScreenOnboarding({ onContinue }) {
  return (
    <div className="dm-pop">
      <PopHeader />
      <div className="dm-body" style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ marginTop: 18, marginBottom: 18 }}>
          <h1 style={{ fontSize: 22, lineHeight: 1.15, margin: 0, fontWeight: 500, letterSpacing: '-0.01em', textWrap: 'balance' }}>
            Bookmarks you actually own.
          </h1>
          <p style={{ marginTop: 10, marginBottom: 0, fontSize: 13, color: dm.inkSoft, lineHeight: 1.55 }}>
            Save links to nostr. Tag them, archive them forever, and read them anywhere — no servers, no lock-in.
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 12.5, color: dm.inkSoft, marginTop: 4 }}>
          {[
            ['01', 'Sign in once with your nsec — stored only on this device.'],
            ['02', 'Click the Deepmarks icon on any page to save it.'],
            ['03', 'Use the same key to log into nostr-enabled sites.'],
          ].map(([n, t]) => (
            <div key={n} style={{ display: 'flex', gap: 12 }}>
              <span className="dm-mono" style={{ color: dm.accent, fontSize: 11, paddingTop: 2 }}>{n}</span>
              <span>{t}</span>
            </div>
          ))}
        </div>

        <div style={{ flex: 1 }} />

        <div style={{ marginTop: 18, padding: 12, background: dm.paperAlt, borderRadius: 3, fontSize: 12, color: dm.inkSoft, border: `1px solid ${dm.hairlineSoft}` }}>
          <div style={{ color: dm.muted, fontFamily: dm.mono, fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase' }}>New to nostr?</div>
          <div style={{ marginTop: 4 }}>
            Generate a key at <span className="dm-link dm-mono" style={{ fontSize: 12 }}>nostr.how/get&#8209;started</span> — takes a minute.
          </div>
        </div>
      </div>
      <div className="dm-footer">
        <button className="dm-btn dm-btn-primary" style={{ flex: 1, padding: '10px' }} onClick={onContinue}>
          Sign in with nsec
        </button>
      </div>
    </div>
  );
}

function ScreenLogin({ onLogin }) {
  const [val, setVal] = React.useState('');
  const valid = val.startsWith('nsec1') && val.length >= 60;
  return (
    <div className="dm-pop">
      <PopHeader title="sign in" right={<MenuDots />} />
      <div className="dm-body">
        <div style={{ marginBottom: 6 }}>
          <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 4 }}>Paste your nsec</div>
          <div style={{ fontSize: 12, color: dm.muted }}>Stays on this device. Never sent anywhere.</div>
        </div>

        <div style={{ marginTop: 18 }}>
          <label className="dm-label">private key</label>
          <input
            type="password"
            className="dm-input dm-mono"
            placeholder="nsec1…"
            value={val}
            onChange={(e) => setVal(e.target.value)}
            autoFocus
          />
          <div style={{ marginTop: 6, fontSize: 11, color: dm.warn, fontFamily: dm.mono, display: 'flex', gap: 6 }}>
            <span>!</span>
            <span style={{ color: dm.muted }}>your nsec is your password. don't paste it into apps you don't trust.</span>
          </div>
        </div>

        <div style={{ marginTop: 22 }}>
          <div className="dm-divider" />
          <div style={{ marginTop: 14, fontSize: 12, color: dm.muted }}>
            Don't have one? <span className="dm-link">Generate a new key →</span>
          </div>
        </div>
      </div>
      <div className="dm-footer">
        <div style={{ flex: 1, fontSize: 11, color: dm.muted }}>encrypted at rest</div>
        <button className="dm-btn dm-btn-primary" disabled={!valid} onClick={() => onLogin && onLogin(val)} style={{ opacity: valid ? 1 : 0.4, padding: '8px 16px' }}>
          Unlock
        </button>
      </div>
    </div>
  );
}

function ScreenSaved({ url = 'https://fiatjaf.com/notes/2025-04-22.html', title = 'A modest proposal for nostr relays', tags = ['nostr', 'longform', 'fiatjaf'], archive = true, onAdd, onView, onClose }) {
  const host = (url.match(/\/\/([^/]+)/) || [])[1] || '';
  const [progress, setProgress] = React.useState(archive ? 0 : 100);
  React.useEffect(() => {
    if (!archive) return;
    let v = 0; const id = setInterval(() => { v = Math.min(100, v + 8); setProgress(v); if (v >= 100) clearInterval(id); }, 80);
    return () => clearInterval(id);
  }, [archive]);

  return (
    <div className="dm-pop">
      <PopHeader title="saved" right={<MenuDots />} npub="npub1jr…7ae" />
      <div className="dm-body" style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
          <span style={{
            width: 22, height: 22, borderRadius: 11, background: dm.good,
            color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 13,
          }}>✓</span>
          <div style={{ fontSize: 14, fontWeight: 500 }}>Bookmarked</div>
          <div style={{ flex: 1 }} />
          <span className="dm-mono" style={{ fontSize: 10, color: dm.muted }}>kind:39701</span>
        </div>

        <div style={{ marginTop: 16, padding: 12, background: '#fff', border: `1px solid ${dm.hairline}`, borderRadius: 3 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
            <Favicon host={host} />
            <span className="dm-mono" style={{ fontSize: 11, color: dm.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{host}</span>
          </div>
          <div style={{ fontSize: 13, fontWeight: 500, lineHeight: 1.35, marginBottom: 6 }}>{title}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {tags.map(t => <span key={t} className="dm-chip">{t}</span>)}
          </div>
        </div>

        <div style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11, color: dm.muted, marginBottom: 6, fontFamily: dm.mono, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            <span>archive</span>
            <span>{archive ? (progress < 100 ? `capturing… ${progress}%` : 'archived ✓') : 'skipped'}</span>
          </div>
          <div className="dm-meter"><div style={{ width: `${archive ? progress : 0}%` }} /></div>
        </div>

        <div style={{ marginTop: 14, fontSize: 11, color: dm.muted, fontFamily: dm.mono, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div>· published to 4 relays</div>
          <div>· event id <span style={{ color: dm.inkSoft }}>e7f3…b21a</span></div>
          {archive && <div>· snapshot stored at <span style={{ color: dm.inkSoft }}>archive.deepmarks.org/3kf2…</span></div>}
        </div>

        <div style={{ flex: 1 }} />
      </div>
      <div className="dm-footer">
        <button className="dm-btn" onClick={onAdd}>+ Add another</button>
        <div style={{ flex: 1 }} />
        <button className="dm-btn dm-btn-ghost" onClick={onView}>View on deepmarks ↗</button>
      </div>
    </div>
  );
}

Object.assign(window, { ScreenOnboarding, ScreenLogin, ScreenSaved });
