// /health — boot/uptime probe. Returns the LN address + signer pubkeys
// so an operator can confirm the server is talking to the right Voltage
// node and the right Box C bunker.

import type { Deps } from '../route-deps.js';

export function register(deps: Deps): void {
  const { app, signers, LN_ADDRESS } = deps;

  app.get('/health', async () => ({
    ok: true,
    ts: Date.now(),
    lnAddress: LN_ADDRESS,
    brandPubkey: signers.brand.pubkey,
    personalPubkey: signers.personal.pubkey,
  }));
}
