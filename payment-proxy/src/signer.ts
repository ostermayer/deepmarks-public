// NIP-46 client — how payment-proxy requests signatures from the Box C
// bunker. The bunker holds the nsecs; we hold only an authorization
// keypair (BUNKER_CLIENT_NSEC) that we use to identify ourselves on
// every request. If this keypair leaks, the blast radius is the
// permission allowlist the bunker enforces for it — kind 9735 / 1985
// against specific identities, nothing else.

import WebSocket from 'ws';
import {
  finalizeEvent,
  getPublicKey,
  nip19,
  nip44,
  type EventTemplate,
  type Event as NostrEvent,
} from 'nostr-tools';

/** Abstract signer so the rest of payment-proxy doesn't know if signing
 *  is local or remote. Always async — even the local case wouldn't be
 *  slowed meaningfully by the micro-task hop. */
export interface RemoteSigner {
  readonly pubkey: string;
  sign(template: EventTemplate): Promise<NostrEvent>;
  close(): void;
}

const NIP46_KIND = 24133;
const DEFAULT_TIMEOUT_MS = 10_000;
const RECONNECT_BACKOFF_MS = [500, 1000, 2000, 5000, 10000] as const;

type PendingResolver = {
  resolve: (event: NostrEvent) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type Logger = {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
};

export interface BunkerSignerOpts {
  /** Identity pubkey we're asking the bunker to sign as. */
  identityPubkey: string;
  /** Client keypair secret (bech32 nsec1… or 64-char hex). Used to
   *  authenticate to the bunker and to derive the NIP-44 conversation
   *  key. This secret authorizes signing; compromise of it gets the
   *  attacker the bunker's permission allowlist, nothing more. */
  clientNsec: string;
  /** Relay the bunker is subscribed on (`ws://strfry:7777` from inside
   *  payment-proxy's docker network — same string strfry uses). */
  relayUrl: string;
  logger: Logger;
}

export class BunkerSigner implements RemoteSigner {
  readonly pubkey: string;
  private readonly clientSecret: Uint8Array;
  private readonly clientPubkey: string;
  private readonly relayUrl: string;
  private readonly conversationKey: Uint8Array;
  private readonly logger: Logger;
  private readonly pending = new Map<string, PendingResolver>();
  private ws: WebSocket | null = null;
  private connectedResolve: (() => void) | null = null;
  private connected: Promise<void>;
  private shouldRun = true;
  private reconnectAttempts = 0;
  private readonly subId: string;

  constructor(opts: BunkerSignerOpts) {
    this.pubkey = opts.identityPubkey;
    this.clientSecret = parseSecret(opts.clientNsec);
    this.clientPubkey = getPublicKey(this.clientSecret);
    this.relayUrl = opts.relayUrl;
    this.conversationKey = nip44.v2.utils.getConversationKey(
      this.clientSecret,
      opts.identityPubkey,
    );
    this.logger = opts.logger;
    // Distinct subscription id per signer instance so a bunker that
    // routes responses by subId can disambiguate when payment-proxy
    // holds multiple signers (brand + personal) on the same ws.
    this.subId = `bunker-client-${opts.identityPubkey.slice(0, 8)}`;
    this.connected = this.newConnectedPromise();
    void this.runForever();
  }

  async sign(template: EventTemplate): Promise<NostrEvent> {
    await this.connected;
    const requestId = randomId();
    const requestPayload = JSON.stringify({
      id: requestId,
      method: 'sign_event',
      params: [JSON.stringify(template)],
    });
    const cipher = nip44.v2.encrypt(requestPayload, this.conversationKey);
    const requestEvent = finalizeEvent(
      {
        kind: NIP46_KIND,
        content: cipher,
        tags: [['p', this.pubkey]],
        created_at: nowSeconds(),
      },
      this.clientSecret,
    );

    const signed: NostrEvent = await new Promise<NostrEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`bunker sign timeout (${DEFAULT_TIMEOUT_MS}ms)`));
      }, DEFAULT_TIMEOUT_MS);

      this.pending.set(requestId, { resolve, reject, timer });

      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new Error('bunker not connected'));
        return;
      }
      this.ws.send(JSON.stringify(['EVENT', requestEvent]));
    });

    return signed;
  }

  close(): void {
    this.shouldRun = false;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('signer closed'));
    }
    this.pending.clear();
    this.ws?.close();
  }

  // ── internals ──────────────────────────────────────────────────────

  private newConnectedPromise(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.connectedResolve = resolve;
    });
  }

  private async runForever(): Promise<void> {
    while (this.shouldRun) {
      try {
        await this.runOnce();
        this.reconnectAttempts = 0;
      } catch (err) {
        this.logger.warn(
          { err: String(err), identity: this.pubkey.slice(0, 8) },
          'bunker connection dropped, reconnecting',
        );
        this.reconnectAttempts++;
      }
      // Reset the `connected` promise so pending sign() callers await it.
      if (this.shouldRun) {
        this.connected = this.newConnectedPromise();
        const delay = RECONNECT_BACKOFF_MS[
          Math.min(this.reconnectAttempts, RECONNECT_BACKOFF_MS.length - 1)
        ];
        await sleep(delay);
      }
    }
  }

  private runOnce(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.relayUrl);
      this.ws = ws;
      let opened = false;

      ws.on('open', () => {
        opened = true;
        this.logger.info(
          { url: this.relayUrl, identity: this.pubkey.slice(0, 8) },
          'bunker relay connected',
        );
        // Subscribe to responses addressed at us, only new events.
        ws.send(
          JSON.stringify([
            'REQ',
            this.subId,
            {
              kinds: [NIP46_KIND],
              '#p': [this.clientPubkey],
              authors: [this.pubkey],
              since: nowSeconds() - 60,
            },
          ]),
        );
        this.connectedResolve?.();
      });

      ws.on('message', (data) => {
        let msg: unknown;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (!Array.isArray(msg)) return;
        if (msg[0] !== 'EVENT' || msg[1] !== this.subId || !msg[2]) return;
        this.handleIncoming(msg[2] as NostrEvent);
      });

      ws.on('close', () => {
        if (opened) resolve();
        else reject(new Error('ws closed before open'));
      });

      ws.on('error', (err) => {
        if (!opened) reject(err);
      });
    });
  }

  private handleIncoming(ev: NostrEvent): void {
    try {
      const plaintext = nip44.v2.decrypt(ev.content, this.conversationKey);
      const parsed = JSON.parse(plaintext) as {
        id?: string;
        result?: string;
        error?: string;
      };
      if (typeof parsed.id !== 'string') return;
      const pending = this.pending.get(parsed.id);
      if (!pending) return;

      clearTimeout(pending.timer);
      this.pending.delete(parsed.id);

      if (parsed.error) {
        pending.reject(new Error(`bunker error: ${parsed.error}`));
        return;
      }
      if (typeof parsed.result !== 'string') {
        pending.reject(new Error('bunker response missing result'));
        return;
      }
      const signed = JSON.parse(parsed.result) as NostrEvent;
      pending.resolve(signed);
    } catch (err) {
      this.logger.warn(
        { err: String(err), identity: this.pubkey.slice(0, 8) },
        'bunker response decrypt/parse failed',
      );
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────

export function parseSecret(raw: string): Uint8Array {
  const trimmed = raw.trim();
  if (trimmed.startsWith('nsec1')) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== 'nsec') throw new Error(`expected nsec, got ${decoded.type}`);
    return decoded.data;
  }
  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      out[i] = Number.parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  throw new Error('secret must be bech32 nsec1… or 64-char hex');
}

function randomId(): string {
  const bytes = new Uint8Array(8);
  // crypto.getRandomValues is available on Node 20+ globally.
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Factory + env loading ────────────────────────────────────────────

export interface SignerSet {
  /** Brand identity — signs zap receipts for zap@ + lifetime labels. */
  brand: RemoteSigner;
  /** Personal identity — signs zap receipts for the operator's personal LN address. */
  personal: RemoteSigner;
  /** Call on shutdown to cleanly close bunker sockets. */
  closeAll: () => void;
}

export interface SignerEnvConfig {
  clientNsec: string;
  relayUrl: string;
  brandPubkey: string;
  personalPubkey: string;
}

export function loadSignerConfigFromEnv(): SignerEnvConfig {
  const missing: string[] = [];
  const read = (k: string): string => {
    const v = process.env[k];
    if (!v) missing.push(k);
    return v ?? '';
  };
  const clientNsec = read('BUNKER_CLIENT_NSEC');
  const relayUrl = read('BUNKER_RELAY_URL');
  const brandPubkey = read('BUNKER_BRAND_PUBKEY');
  const personalPubkey = read('BUNKER_PERSONAL_PUBKEY');
  if (missing.length) {
    throw new Error(`missing signer env: ${missing.join(', ')}`);
  }
  return { clientNsec, relayUrl, brandPubkey, personalPubkey };
}

export function buildSigners(config: SignerEnvConfig, logger: Logger): SignerSet {
  const brand = new BunkerSigner({
    identityPubkey: config.brandPubkey,
    clientNsec: config.clientNsec,
    relayUrl: config.relayUrl,
    logger,
  });
  const personal = new BunkerSigner({
    identityPubkey: config.personalPubkey,
    clientNsec: config.clientNsec,
    relayUrl: config.relayUrl,
    logger,
  });
  return {
    brand,
    personal,
    closeAll: () => {
      brand.close();
      personal.close();
    },
  };
}
