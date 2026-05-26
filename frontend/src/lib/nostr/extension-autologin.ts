import { browser } from '$app/environment';
import {
  createDeepmarksExtensionSigner,
  isDeepmarksExtensionAvailable,
} from '$lib/nostr/signers';
import { currentSession, session } from '$lib/stores/session';

const AUTO_LOGIN_ATTEMPT_KEY = 'deepmarks-first-party-autologin:v1';
const AUTO_LOGIN_SUPPRESSED_KEY = 'deepmarks-first-party-autologin-suppressed:v1';

export function suppressDeepmarksAutoLoginOnce(): void {
  if (!browser) return;
  try {
    sessionStorage.setItem(AUTO_LOGIN_SUPPRESSED_KEY, '1');
  } catch {
    // Private mode can reject storage writes. Logout still clears the session.
  }
}

function isDeepmarksAutoLoginSuppressed(): boolean {
  if (!browser) return false;
  try {
    return sessionStorage.getItem(AUTO_LOGIN_SUPPRESSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function consumeDeepmarksAutoLoginSuppression(): boolean {
  if (!isDeepmarksAutoLoginSuppressed()) return false;
  try {
    sessionStorage.removeItem(AUTO_LOGIN_SUPPRESSED_KEY);
  } catch {
    // Keep rendering the logged-out landing page.
  }
  return true;
}

export async function waitForDeepmarksExtension(timeoutMs = 1200): Promise<boolean> {
  if (!browser) return false;
  if (isDeepmarksExtensionAvailable()) return true;

  const startedAt = Date.now();
  return new Promise((resolve) => {
    const poll = () => {
      if (isDeepmarksExtensionAvailable()) {
        resolve(true);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(poll, 50);
    };
    setTimeout(poll, 0);
  });
}

export function shouldAttemptDeepmarksAutoLogin(force = false): boolean {
  if (!browser || !isDeepmarksExtensionAvailable()) return false;
  if (!force && isDeepmarksAutoLoginSuppressed()) return false;
  if (force) return true;
  try {
    if (sessionStorage.getItem(AUTO_LOGIN_ATTEMPT_KEY) === '1') return false;
    sessionStorage.setItem(AUTO_LOGIN_ATTEMPT_KEY, '1');
  } catch {
    // Private mode can reject storage writes. In that case, one best-effort
    // attempt is still better than forcing the user through /login.
  }
  return true;
}

export async function loginWithDeepmarksExtension(): Promise<string | null> {
  const signer = await createDeepmarksExtensionSigner();
  await session.login(signer);
  return currentSession().pubkey;
}
