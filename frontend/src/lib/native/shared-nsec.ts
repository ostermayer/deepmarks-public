// JS bridge to the iOS SharedNsec Capacitor plugin.
//
// The main app stores the user's nsec in a shared Keychain access
// group so the DeepmarksShare extension can read it on its own and
// sign + POST /publish without waiting for the main app to
// foreground. Web + non-iOS builds get a no-op stub.

import { Capacitor, registerPlugin } from '@capacitor/core';
import { isNativeShell } from './runtime';

interface SharedNsecPlugin {
  save(options: { nsecHex: string }): Promise<void>;
  load(): Promise<{ nsecHex: string | null }>;
  clear(): Promise<void>;
}

const stub: SharedNsecPlugin = {
  async save() { /* web — nothing to do */ },
  async load() { return { nsecHex: null }; },
  async clear() { /* web — nothing to do */ },
};

const SharedNsec: SharedNsecPlugin = isNativeShell() && Capacitor.getPlatform() === 'ios'
  ? registerPlugin<SharedNsecPlugin>('SharedNsec')
  : stub;

/** Persist the user's nsec into the shared Keychain so the share
 *  extension can pick it up. Best-effort — on web / Android / unconfigured
 *  builds this is a no-op. */
export async function saveSharedNsec(nsecHex: string): Promise<void> {
  if (!/^[0-9a-f]{64}$/i.test(nsecHex)) return;
  try { await SharedNsec.save({ nsecHex: nsecHex.toLowerCase() }); }
  catch { /* keychain failures are non-fatal — share extension just
              falls back to the AppGroup pending-shares queue */ }
}

/** Wipe the shared-keychain nsec. Call on logout so the share
 *  extension doesn't keep signing on behalf of the previous user. */
export async function clearSharedNsec(): Promise<void> {
  try { await SharedNsec.clear(); }
  catch { /* tolerable — same fallback */ }
}

/** Mostly here for tests / diagnostics. Production code should
 *  never need to read the nsec back through the JS bridge. */
export async function loadSharedNsec(): Promise<string | null> {
  try {
    const result = await SharedNsec.load();
    return result.nsecHex;
  } catch {
    return null;
  }
}
