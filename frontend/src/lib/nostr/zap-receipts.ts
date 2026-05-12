import type { NDKEvent, NDKSubscription } from '@nostr-dev-kit/ndk';
import { getNdk, whenReady } from './ndk.js';
import { KIND } from './kinds.js';
import type { ZapInvoice } from './zap.js';
import { invoiceKey } from './zap-flow.js';

export interface ZapReceiptWatchCallbacks {
  onStatus: (status: string) => void;
  onPaid: (paidInvoiceKeys: Set<string>) => void;
  onAllPaid: () => void;
}

export interface ZapReceiptWatcher {
  stop: () => void;
}

export function watchZapReceipts(
  invoices: ZapInvoice[],
  callbacks: ZapReceiptWatchCallbacks,
): ZapReceiptWatcher {
  let stopped = false;
  let sub: NDKSubscription | null = null;
  const invoiceByKey = new Map(invoices.map((inv) => [invoiceKey(inv.invoice), inv]));
  const paid = new Set<string>();

  function stop() {
    stopped = true;
    sub?.stop();
    sub = null;
    callbacks.onStatus('');
  }

  function handleReceipt(event: NDKEvent) {
    const bolt11 = event.tags.find((t) => t[0] === 'bolt11')?.[1];
    if (!bolt11) return;
    const key = invoiceKey(bolt11);
    if (!invoiceByKey.has(key) || paid.has(key)) return;

    paid.add(key);
    callbacks.onPaid(new Set(paid));

    if (paid.size >= invoiceByKey.size) {
      stop();
      callbacks.onAllPaid();
      return;
    }

    callbacks.onStatus(`${paid.size} of ${invoiceByKey.size} invoices confirmed`);
  }

  void (async () => {
    callbacks.onStatus('waiting for zap receipt');
    try {
      await whenReady().catch(() => undefined);
      if (stopped) return;
      const ndk = getNdk();
      const since = Math.floor(Date.now() / 1000) - 120;
      sub = ndk.subscribe({ kinds: [KIND.zapReceipt], since }, { closeOnEose: false });
      sub.on('event', handleReceipt);
    } catch {
      if (!stopped) callbacks.onStatus('waiting for wallet confirmation');
    }
  })();

  return { stop };
}
