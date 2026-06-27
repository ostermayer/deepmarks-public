// Minimal Nostr relay client. We don't use nostr-tools' Relay class
// because we want explicit control over reconnect + don't need the
// abstraction. Protocol: send ["REQ", subId, filter], receive
// ["EVENT", subId, ev] | ["EOSE", subId] | ["OK", evId, ok, msg] |
// ["NOTICE", msg]. Send a signed response with ["EVENT", ev].

import WebSocket from 'ws';
import type { Event as NostrEvent } from 'nostr-tools';
import { NIP46_KIND } from './nip46.js';

export interface RelayLogger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
}

const SUB_ID = 'bunker';
const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000] as const;

/**
 * Persistent NIP-46 subscription. Reconnects with backoff on any
 * disconnect. `onRequest` receives each kind:24133 event addressed at
 * one of our identity pubkeys and returns the signed response event to
 * publish, or null to skip.
 */
export class RelayConnection {
  private ws: WebSocket | null = null;
  private shouldRun = true;
  private reconnectAttempts = 0;

  constructor(
    private readonly url: string,
    private readonly subscribePubkeys: string[],
    private readonly onRequest: (ev: NostrEvent) => Promise<NostrEvent | null>,
    private readonly logger: RelayLogger,
  ) {}

  async start(): Promise<void> {
    while (this.shouldRun) {
      try {
        await this.runOnce();
        // Clean close — next loop iteration will try to reconnect.
        this.reconnectAttempts = 0;
      } catch (err) {
        const delay = RECONNECT_BACKOFF_MS[
          Math.min(this.reconnectAttempts, RECONNECT_BACKOFF_MS.length - 1)
        ];
        this.logger.warn({ err: String(err), delay }, 'relay disconnected, reconnecting');
        this.reconnectAttempts++;
      }
      if (this.shouldRun) {
        const delay =
          this.reconnectAttempts === 0
            ? 0
            : RECONNECT_BACKOFF_MS[
                Math.min(this.reconnectAttempts - 1, RECONNECT_BACKOFF_MS.length - 1)
              ];
        if (delay > 0) await sleep(delay);
      }
    }
  }

  async stop(): Promise<void> {
    this.shouldRun = false;
    const ws = this.ws;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close();
    }
  }

  private runOnce(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      let opened = false;

      ws.on('open', () => {
        opened = true;
        this.logger.info({ url: this.url, pubkeys: this.subscribePubkeys.length }, 'relay connected');
        ws.send(
          JSON.stringify([
            'REQ',
            SUB_ID,
            { kinds: [NIP46_KIND], '#p': this.subscribePubkeys },
          ]),
        );
      });

      ws.on('message', async (data) => {
        let msg: unknown;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return; // malformed relay frames — ignore
        }
        if (!Array.isArray(msg)) return;
        if (msg[0] !== 'EVENT' || msg[1] !== SUB_ID || !msg[2]) return;

        try {
          const resp = await this.onRequest(msg[2] as NostrEvent);
          if (resp && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(['EVENT', resp]));
          }
        } catch (err) {
          this.logger.error({ err: String(err) }, 'request handler threw');
        }
      });

      ws.on('close', () => {
        if (opened) {
          resolve();
        } else {
          reject(new Error('websocket closed before open'));
        }
      });

      ws.on('error', (err) => {
        // 'error' usually precedes 'close'. Track both — if we already
        // opened, let 'close' resolve; otherwise reject here.
        if (!opened) reject(err);
      });
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
