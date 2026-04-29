// NWC (NIP-47 / Nostr Wallet Connect) connection store.
//
// One connection per browser profile; chrome.storage.local-backed so
// it survives popup close + browser restart. The secret is treated
// like the user's nsec — sensitive, never logged, never shipped to
// our server.
//
// Schema is opaque to callers: use parseNwcUri / loadNwc / saveNwc /
// clearNwc instead of poking at storage directly.

const KEY = 'deepmarks-nwc';

export interface NwcConnection {
  /** Wallet's pubkey (hex). All NWC requests are encrypted to this. */
  walletPubkey: string;
  /** Relay URL the wallet listens on (single relay per connection). */
  relayUrl: string;
  /** Hex-encoded 32-byte secret minted by the wallet for this app.
   *  Acts as the app's identity for the NWC channel — we sign the
   *  kind:23194 request with it. NEVER the user's main nsec. */
  appSecret: string;
  /** Optional lightning address the wallet wants payments routed to.
   *  Surfaced in some implementations but not required for pay_invoice. */
  lud16?: string;
  /** When the user pasted the URI. */
  connectedAt: number;
}

/** Parse a `nostr+walletconnect://` URI into a connection record.
 *  Throws on malformed input — callers should surface the error message. */
export function parseNwcUri(uri: string): NwcConnection {
  const trimmed = uri.trim();
  // Both `nostr+walletconnect:` and `nostrwalletconnect:` schemes appear
  // in the wild; older Alby exports omit the +. Accept either. Some
  // wallets emit the URI with `://` and some without — parse both.
  const stripped = trimmed
    .replace(/^nostr\+walletconnect:(\/\/)?/i, '')
    .replace(/^nostrwalletconnect:(\/\/)?/i, '');
  if (stripped === trimmed) {
    throw new Error('not an NWC URI — expected nostr+walletconnect://…');
  }
  const [pubkeyPart, queryPart] = stripped.split('?');
  if (!pubkeyPart || !queryPart) {
    throw new Error('NWC URI missing pubkey or query string');
  }
  const walletPubkey = pubkeyPart.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(walletPubkey)) {
    throw new Error('NWC wallet pubkey must be 64 hex chars');
  }
  const params = new URLSearchParams(queryPart);
  const relayUrl = params.get('relay');
  const appSecret = params.get('secret');
  if (!relayUrl) throw new Error('NWC URI missing relay parameter');
  if (!/^wss?:\/\//i.test(relayUrl)) throw new Error('NWC relay must be ws:// or wss://');
  if (!appSecret || !/^[0-9a-f]{64}$/i.test(appSecret)) {
    throw new Error('NWC URI missing or invalid 64-hex secret');
  }
  return {
    walletPubkey,
    relayUrl,
    appSecret: appSecret.toLowerCase(),
    lud16: params.get('lud16') ?? undefined,
    connectedAt: Math.floor(Date.now() / 1000),
  };
}

export async function loadNwc(): Promise<NwcConnection | null> {
  const raw = await chrome.storage.local.get(KEY);
  const value = raw[KEY] as NwcConnection | undefined;
  if (!value || typeof value !== 'object') return null;
  if (!value.walletPubkey || !value.relayUrl || !value.appSecret) return null;
  return value;
}

export async function saveNwc(conn: NwcConnection): Promise<void> {
  await chrome.storage.local.set({ [KEY]: conn });
}

export async function clearNwc(): Promise<void> {
  await chrome.storage.local.remove(KEY);
}
