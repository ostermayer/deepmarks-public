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

import { useEffect, useState } from 'react';
import { nsecStore, type NsecState } from '../lib/nsec-store.js';
import { navigate, replace, useScreen } from './router.js';
import { Onboarding } from './screens/Onboarding.js';
import { Login } from './screens/Login.js';
import { SetPassword } from './screens/SetPassword.js';
import { Unlock } from './screens/Unlock.js';
import { Recent } from './screens/Recent.js';
import { Add } from './screens/Add.js';
import { SignRequest } from './screens/SignRequest.js';
import { Settings } from './screens/Settings.js';

const EMPTY_STATE: NsecState = {
  empty: true, locked: false, protected: false,
  pubkey: null, nsecHex: null, signedInAt: null,
};

export function App() {
  const [state, setState] = useState<NsecState | 'loading'>('loading');
  const screen = useScreen();

  useEffect(() => {
    void nsecStore.getState().then(async (s) => {
      setState(s);
      // If a Nostr web app (Coracle, Damus web, snort.social, etc.)
      // triggered a NIP-07 call that requires user approval, the
      // background service worker pushed it onto its pendingRequests
      // map and called chrome.action.openPopup. We need to land on
      // the SignRequest screen so the user can approve/reject —
      // otherwise the popup looks like the regular bookmark UI and
      // the auth never completes. Only route there when actually
      // pending; an empty list means the popup was opened by the
      // toolbar click and the bookmark UI is the right landing.
      try {
        const reply = await chrome.runtime.sendMessage({ kind: 'nip07-list-pending' });
        if (reply?.pending?.length > 0) {
          replace('sign-request');
          return;
        }
      } catch {
        // Background SW unreachable (rare, mid-update) — fall through
        // to the normal landing.
      }
      replace(landingFor(s));
    });
  }, []);

  if (state === 'loading') return null;

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
    return <Unlock state={state} onUnlocked={(s) => setState(s)} />;
  }

  switch (screen) {
    case 'onboarding':   return <Onboarding />;
    case 'login':        return (
      <Login onSignedIn={(s) => {
        setState(s);
        // Right after sign-in: prompt for a password (with Skip option).
        // Returning users who already set one don't need this — go to
        // recent. New + paste users land on the password setup.
        navigate(s.protected ? 'recent' : 'set-password');
      }} />
    );
    case 'set-password': return (
      <SetPassword onDone={(s) => { setState(s); navigate('recent'); }} />
    );
    case 'unlock':       return (
      <Unlock state={state} onUnlocked={(s) => { setState(s); navigate('recent'); }} />
    );
    case 'recent':       return <Recent state={state} />;
    case 'add':          return <Add state={state} />;
    case 'sign-request': return <SignRequest />;
    case 'settings':     return (
      <Settings
        state={state}
        onStateChange={(s) => setState(s)}
        onSignOut={() => { setState(EMPTY_STATE); navigate('onboarding'); }}
      />
    );
  }
}

function landingFor(s: NsecState): 'onboarding' | 'recent' {
  return s.empty ? 'onboarding' : 'recent';
}
