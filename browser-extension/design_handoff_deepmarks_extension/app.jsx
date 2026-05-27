// app.jsx — Main app: prototype + design canvas

const { useState, useEffect } = React;

// ─── Prototype: simulates the popup-on-page experience ─────────────────────
function PopupShell({ children, label }) {
  return (
    <div style={{ position: 'relative' }}>
      <div style={{
        width: POPUP_W, height: POPUP_H,
        boxShadow: '0 24px 60px -12px rgba(20,15,5,0.18), 0 8px 16px -8px rgba(20,15,5,0.12)',
        border: `1px solid ${dm.hairline}`, borderRadius: 6, overflow: 'hidden',
        background: dm.paper,
      }}>
        {children}
      </div>
      {label && (
        <div className="dm-mono" style={{
          position: 'absolute', bottom: -22, left: 4, fontSize: 10, color: 'rgba(60,50,40,.55)',
          letterSpacing: '0.08em', textTransform: 'uppercase',
        }}>{label}</div>
      )}
    </div>
  );
}

const TWEAKS_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "warm-rust",
  "density": "comfy",
  "showAutofillPing": true
}/*EDITMODE-END*/;

const ACCENT_MAP = {
  'warm-rust': 'oklch(0.55 0.15 25)',
  'forest': 'oklch(0.5 0.13 145)',
  'indigo': 'oklch(0.5 0.16 265)',
  'graphite': '#1a1a1a',
};

function Prototype() {
  const [tweaks, setTweak] = useTweaks(TWEAKS_DEFAULTS);
  const [screen, setScreen] = useState('recent');
  const [lastSaved, setLastSaved] = useState(null);

  // Live re-tint accent — only modify the override node, never touch base styles
  useEffect(() => {
    const accent = ACCENT_MAP[tweaks.accent] || ACCENT_MAP['warm-rust'];
    dm.accent = accent;
    let s = document.getElementById('dm-popup-styles-override');
    if (!s) {
      s = document.createElement('style');
      s.id = 'dm-popup-styles-override';
      document.head.appendChild(s);
    }
    s.textContent = `
      .dm-link { color: ${accent} !important; }
      .dm-chip-x:hover { color: ${accent} !important; }
      .dm-meter > div { background: ${accent} !important; }
      .dm-brand { color: ${accent} !important; }
      .dm-brand-dot { color: ${accent} !important; }
      .dm-btn-danger { color: ${accent} !important; }
    `;
  }, [tweaks.accent]);

  const screens = {
    onboarding: <ScreenOnboarding onContinue={() => setScreen('login')} />,
    login: <ScreenLogin onLogin={() => setScreen('recent')} />,
    recent: <ScreenRecent onAdd={() => setScreen('add')} onSettings={() => setScreen('settings')} />,
    add: <ScreenAdd onSave={(b) => { setLastSaved(b); setScreen('saved'); }} onClose={() => setScreen('recent')} />,
    saved: <ScreenSaved onAdd={() => setScreen('add')} onView={() => setScreen('recent')} onClose={() => setScreen('recent')} />,
    sign: <ScreenSignRequest onApprove={() => setScreen('recent')} onReject={() => setScreen('recent')} />,
    settings: <ScreenSettings onBack={() => setScreen('recent')} />,
  };

  // Settings is a wider window; popup screens are 400 wide
  const isSettings = screen === 'settings';

  return (
    <div style={{ width: '100%', height: '100%', background: '#e9e6df', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <FakeBrowserChrome screen={screen} setScreen={setScreen} />
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <FakeWebsite />
        {/* Popup anchored to the toolbar icon */}
        {!isSettings && (
          <div style={{ position: 'absolute', top: 8, right: 18, zIndex: 5 }}>
            <PopupShell>{screens[screen]}</PopupShell>
          </div>
        )}
        {isSettings && (
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(20,15,5,0.35)', zIndex: 5, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
            <div style={{
              width: 720, height: 560, borderRadius: 6, overflow: 'hidden',
              boxShadow: '0 24px 60px -12px rgba(20,15,5,0.4)',
              border: `1px solid ${dm.hairline}`, background: dm.paper,
            }}>{screens.settings}</div>
          </div>
        )}
      </div>
      <TweaksPanel title="Tweaks">
        <TweakSection label="Theme" />
        <TweakSelect
          label="Accent"
          value={tweaks.accent}
          options={['warm-rust', 'forest', 'indigo', 'graphite']}
          onChange={(v) => setTweak('accent', v)}
        />
        <TweakSection label="Demo navigation" />
        <div style={{ padding: '0 4px 6px' }}>
          <DemoNav screen={screen} setScreen={setScreen} />
        </div>
      </TweaksPanel>
    </div>
  );
}

function DemoNav({ screen, setScreen }) {
  const items = [
    ['onboarding', 'Onboarding'],
    ['login', 'Login (paste nsec)'],
    ['recent', 'Recent bookmarks'],
    ['add', 'Add bookmark'],
    ['saved', 'Saved confirmation'],
    ['sign', 'Nostr sign-in request'],
    ['settings', 'Settings page'],
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {items.map(([k, l]) => (
        <button key={k} onClick={() => setScreen(k)} style={{
          textAlign: 'left', padding: '6px 8px', border: 'none', cursor: 'pointer',
          background: screen === k ? '#2a251f' : 'transparent',
          color: screen === k ? '#fff' : '#3d3a35',
          fontFamily: dm.sans, fontSize: 12, borderRadius: 3,
        }}>{l}</button>
      ))}
    </div>
  );
}

function FakeBrowserChrome({ screen, setScreen }) {
  const onSign = screen === 'sign';
  return (
    <div style={{ flexShrink: 0, background: '#dad6cd', borderBottom: `1px solid ${dm.hairline}`, fontFamily: dm.sans }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px' }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <div style={{ width: 11, height: 11, borderRadius: '50%', background: '#ff5f57' }} />
          <div style={{ width: 11, height: 11, borderRadius: '50%', background: '#febc2e' }} />
          <div style={{ width: 11, height: 11, borderRadius: '50%', background: '#28c840' }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', height: 28, marginLeft: 8 }}>
          <div style={{
            padding: '4px 12px 6px', background: dm.paper, borderRadius: '6px 6px 0 0', fontSize: 11.5,
            display: 'flex', alignItems: 'center', gap: 8, fontFamily: dm.sans,
          }}>
            <Favicon host={onSign ? 'stacker.news' : 'fiatjaf.com'} size={12} />
            <span>{onSign ? 'Stacker News · Sign in' : 'fiatjaf — A modest proposal for nostr relays'}</span>
            <span style={{ color: dm.muted, fontSize: 12, marginLeft: 4 }}>×</span>
          </div>
        </div>
        <div style={{ flex: 1 }} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 14px 10px', background: dm.paper, borderBottom: `1px solid ${dm.hairline}` }}>
        <span style={{ color: dm.muted, fontSize: 14 }}>← →</span>
        <div className="dm-mono" style={{
          flex: 1, padding: '5px 10px', background: '#f4f1e9', border: `1px solid ${dm.hairline}`, borderRadius: 4,
          fontSize: 11.5, color: dm.inkSoft,
        }}>{onSign ? 'https://stacker.news/login' : 'https://fiatjaf.com/notes/2025-04-22.html'}</div>
        {/* Toolbar icon — clickable */}
        <div onClick={() => setScreen(s => s === 'recent' ? 'add' : 'recent')} title="Click Deepmarks" style={{
          width: 28, height: 28, borderRadius: 4, border: `1px solid ${dm.hairline}`, background: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', position: 'relative',
        }}>
          <Pennant size={16} />
          <span style={{
            position: 'absolute', top: -3, right: -3, fontSize: 8, padding: '1px 3px',
            background: dm.accent, color: '#fff', borderRadius: 8, fontWeight: 600, lineHeight: 1, fontFamily: dm.mono,
          }}>3</span>
        </div>
      </div>
    </div>
  );
}

function FakeWebsite() {
  return (
    <div style={{ height: '100%', overflow: 'hidden', padding: '32px 56px', fontFamily: 'Georgia, serif', color: dm.inkSoft, background: dm.paper }}>
      <div style={{ maxWidth: 620 }}>
        <div className="dm-mono" style={{ fontSize: 11, color: dm.muted, textTransform: 'uppercase', letterSpacing: '0.08em' }}>fiatjaf.com · Apr 22, 2026</div>
        <h1 style={{ fontSize: 28, marginTop: 12, marginBottom: 16, fontWeight: 500, color: dm.ink, letterSpacing: '-0.01em' }}>
          A modest proposal for nostr relays
        </h1>
        <p style={{ fontSize: 15, lineHeight: 1.7, marginBottom: 14 }}>
          The relay model has been the most interesting and most misunderstood part of nostr from day one. People keep wanting to make it into something it isn't — a database, a social graph, a moderation layer.
        </p>
        <p style={{ fontSize: 15, lineHeight: 1.7, marginBottom: 14 }}>
          A relay is a dumb pipe. That's the point. A dumb pipe with policies attached, sure, but the policies are a relay's business, not the protocol's. The protocol is the message format and the signatures.
        </p>
        <p style={{ fontSize: 15, lineHeight: 1.7, color: dm.muted }}>
          [continues for 1,800 more words…]
        </p>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('proto-root')).render(<Prototype />);

// ─── Design Canvas: every screen as an artboard ────────────────────────────
function CanvasView() {
  return (
    <DesignCanvas>
      <DCSection id="primary" title="Primary flow" subtitle="Sign in → bookmark → confirm">
        <DCArtboard id="onboarding" label="01 · Onboarding" width={POPUP_W} height={POPUP_H}>
          <ScreenOnboarding />
        </DCArtboard>
        <DCArtboard id="login" label="02 · Login (paste nsec)" width={POPUP_W} height={POPUP_H}>
          <ScreenLogin />
        </DCArtboard>
        <DCArtboard id="add" label="03 · Add bookmark" width={POPUP_W} height={POPUP_H}>
          <ScreenAdd />
        </DCArtboard>
        <DCArtboard id="saved" label="04 · Saved (archiving)" width={POPUP_W} height={POPUP_H}>
          <ScreenSaved />
        </DCArtboard>
      </DCSection>

      <DCSection id="library" title="Library" subtitle="Recent bookmarks list">
        <DCArtboard id="recent" label="05 · Recent" width={POPUP_W} height={POPUP_H}>
          <ScreenRecent />
        </DCArtboard>
      </DCSection>

      <DCSection id="signin" title="Nostr sign-in (NIP-07)" subtitle="Other sites request a signature with your key">
        <DCArtboard id="sign" label="06 · Sign request" width={POPUP_W} height={POPUP_H}>
          <ScreenSignRequest />
        </DCArtboard>
      </DCSection>

      <DCSection id="settings" title="Settings" subtitle="Wider, tabbed view (opens as its own page)">
        <DCArtboard id="settings-relays" label="07 · Settings — Relays" width={720} height={POPUP_H}>
          <ScreenSettings />
        </DCArtboard>
      </DCSection>
    </DesignCanvas>
  );
}

ReactDOM.createRoot(document.getElementById('canvas-root')).render(<CanvasView />);
