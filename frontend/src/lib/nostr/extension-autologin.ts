import { browser } from '$app/environment';
import {
  createDeepmarksExtensionSigner,
  isDeepmarksExtensionAvailable,
} from '$lib/nostr/signers';
import { currentSession, session } from '$lib/stores/session';

const AUTO_LOGIN_ATTEMPT_KEY = 'deepmarks-first-party-autologin:v1';

export function shouldAttemptDeepmarksAutoLogin(force = false): boolean {
  if (!browser || !isDeepmarksExtensionAvailable()) return false;
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
