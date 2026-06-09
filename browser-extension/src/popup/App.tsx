// Popup root.
//
// On mount: snapshot nsec-store state and pick a landing screen.
//   - empty       → Onboarding → Login
//   - locked      → Recent header is shown but the body routes to Unlock
//                   (so the user knows which account they're unlocking)
//   - unlocked    → Recent
//
// All sub-screens get the live NsecState; signing/publish operations
// gate on `state.nsecHex` being non-null.

import { Component, useEffect, useState, type CSSProperties, type ErrorInfo, type ReactNode } from 'react';
import { nsecStore, type NsecState } from '../lib/nsec-store.js';
import { syncSettingsAndPublishedRelays } from '../lib/relay-sync.js';
import { drainPendingPublishes } from '../lib/pending-publish.js';
import { navigate, replace, useScreen } from './router.js';
import { Onboarding } from './screens/Onboarding.js';
import { Login } from './screens/Login.js';
import { SetPassword } from './screens/SetPassword.js';
import { Unlock } from './screens/Unlock.js';
import { Recent } from './screens/Recent.js';
import { Add } from './screens/Add.js';
import { SignRequest } from './screens/SignRequest.js';
import { Settings } from './screens/Settings.js';
import { hasAddBookmarkDraft, hasLoginDraft } from './screens/popup-drafts.js';
import { Pennant } from '../shared/Pennant.js';
import { colors, fonts, fontSize, radius, space } from '../shared/tokens.js';

const EMPTY_STATE: NsecState = {
  empty: true, locked: false, protected: false,
  pubkey: null, nsecHex: null, signedInAt: null,
};

export function App() {
  const [state, setState] = useState<NsecState | 'loading'>('loading');
  const [bootError, setBootError] = useState<string | null>(null);
  const screen = useScreen();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const s = await withTimeout(
          nsecStore.getState(),
          4000,
          'Safari did not return Deepmarks storage in time.',
        );
        if (cancelled) return;
        setBootError(null);
        setState(s);
        if (s.nsecHex) void syncSettingsAndPublishedRelays(s.pubkey, s.nsecHex).catch(() => undefined);
        // If a Nostr web app (Coracle, Damus web, snort.social, etc.)
        // triggered a NIP-07 or WebLN call that requires user approval, the
        // background service worker pushed it onto its pendingRequests
        // map and called chrome.action.openPopup. We need to land on
        // the SignRequest screen so the user can approve/reject —
        // otherwise the popup looks like the regular bookmark UI and
        // the auth never completes. Only route there when actually
        // pending; an empty list means the popup was opened by the
        // toolbar click and the bookmark UI is the right landing.
        //
        // Hard cap the round-trip: Safari sometimes leaves a popup's
        // sendMessage hanging when the background SW is being woken,
        // which sticks the popover on "Opening..." and then blocks
        // subsequent toolbar clicks from reopening it. If we don't hear
        // back in time we just land on the normal screen.
        const pending = await withTimeoutFallback(
          chrome.runtime.sendMessage({ kind: 'nip07-list-pending' })
            .then((reply) => (reply?.pending?.length ?? 0) > 0)
            .catch(() => false),
          1200,
          false,
        );
        if (cancelled) return;
        if (pending) {
          replace('sign-request');
          return;
        }
        const landing = await withTimeoutFallback(landingFor(s), 1500, fallbackLanding(s));
        if (cancelled) return;
        replace(landing);
      } catch (e) {
        if (cancelled) return;
        setBootError((e as Error).message || 'Deepmarks could not open.');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (state === 'loading' || !state.nsecHex || !state.pubkey || state.locked) return;
    let cancelled = false;
    const { nsecHex, pubkey } = state;
    const drain = () => {
      if (cancelled) return;
      void drainPendingPublishes(nsecHex, pubkey).catch(() => undefined);
    };
    drain();
    const timer = setInterval(drain, 90_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [state]);

  if (bootError) return <PopupFailure message={bootError} />;
  if (state === 'loading') return <PopupLoading />;

  // Locked encrypted account: short-circuit any screen that needs the
  // nsec to function. Settings stays accessible (you can change/remove
  // password from there). SignRequest stays accessible (rejecting a
  // sign request doesn't need the nsec).
  const needsKey: Record<string, boolean> = {
    recent: true, add: true,
    onboarding: false, login: false, 'set-password': false, unlock: false,
    'sign-request': false, settings: false,
  };
  if (state.locked && needsKey[screen]) {
    return (
      <PopupErrorBoundary>
        <Unlock state={state} onUnlocked={(s) => setState(s)} />
      </PopupErrorBoundary>
    );
  }

  return (
    <PopupErrorBoundary>
      {screen === 'onboarding' && <Onboarding />}
      {screen === 'login' && (
        <Login onSignedIn={(s) => {
          setState(s);
          // New sign-ins write encrypted-at-rest directly. Legacy plaintext
          // records still route through set-password before normal use.
          navigate(s.protected ? 'recent' : 'set-password');
        }} />
      )}
      {screen === 'set-password' && (
        <SetPassword onDone={(s) => { setState(s); navigate('recent'); }} />
      )}
      {screen === 'unlock' && (
        <Unlock state={state} onUnlocked={(s) => { setState(s); navigate('recent'); }} />
      )}
      {screen === 'recent' && <Recent state={state} />}
      {screen === 'add' && <Add state={state} />}
      {screen === 'sign-request' && <SignRequest />}
      {screen === 'settings' && (
        <Settings
          state={state}
          onStateChange={(s) => setState(s)}
          onSignOut={() => { setState(EMPTY_STATE); navigate('onboarding'); }}
        />
      )}
    </PopupErrorBoundary>
  );
}

type Landing = 'onboarding' | 'login' | 'set-password' | 'recent' | 'add';

async function landingFor(s: NsecState): Promise<Landing> {
  if (s.empty) return await hasLoginDraft() ? 'login' : 'onboarding';
  if (!s.protected) return 'set-password';
  if (await hasAddBookmarkDraft()) return 'add';
  return 'recent';
}

/** Safe default when the draft probe in landingFor times out. The
 *  draft check is a UX nicety (resume an unsent bookmark / login),
 *  not load-bearing — falling back to the steady-state screen is
 *  fine. */
function fallbackLanding(s: NsecState): Landing {
  if (s.empty) return 'onboarding';
  if (!s.protected) return 'set-password';
  return 'recent';
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withTimeoutFallback<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class PopupErrorBoundary extends Component<{ children: ReactNode }, { message: string | null }> {
  state = { message: null };

  static getDerivedStateFromError(error: Error): { message: string } {
    return { message: error.message || 'Deepmarks could not open this view.' };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[deepmarks] popup render failed', error, info);
  }

  render(): ReactNode {
    if (this.state.message) return <PopupFailure message={this.state.message} />;
    return this.props.children;
  }
}

function PopupLoading(): ReactNode {
  return (
    <div style={messageShell}>
      <div style={messageBrand}><Pennant size={16} /> Deepmarks</div>
      <p style={messageText}>Opening...</p>
    </div>
  );
}

function PopupFailure({ message }: { message: string }): ReactNode {
  return (
    <div style={messageShell}>
      <div style={messageBrand}><Pennant size={16} /> Deepmarks</div>
      <p style={messageText}>{message}</p>
      <button type="button" style={messageButton} onClick={() => window.location.reload()}>
        Try again
      </button>
    </div>
  );
}

const messageShell: CSSProperties = {
  minHeight: '100%',
  boxSizing: 'border-box',
  padding: space.xl,
  background: colors.paper,
  color: colors.ink,
  fontFamily: fonts.sans,
  display: 'flex',
  flexDirection: 'column',
  gap: space.lg,
};

const messageBrand: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontFamily: fonts.mono,
  fontSize: fontSize.bodyMicro,
  color: colors.accent,
};

const messageText: CSSProperties = {
  margin: 0,
  fontSize: fontSize.bodySmall,
  color: colors.inkSoft,
  lineHeight: 1.5,
};

const messageButton: CSSProperties = {
  alignSelf: 'flex-start',
  padding: `${space.sm}px ${space.lg}px`,
  border: `1px solid ${colors.hairline}`,
  borderRadius: radius.std,
  background: 'transparent',
  color: colors.inkSoft,
  fontFamily: fonts.sans,
  fontSize: fontSize.metaSmall,
  cursor: 'pointer',
};
