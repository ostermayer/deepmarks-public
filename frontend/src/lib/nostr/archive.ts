// Archive purchase orchestration. Encapsulates the four steps of flow B:
//   1. ask payment-proxy for a BOLT-11 invoice
//   2. pay it via WebLN
//   3. poll /archive/status until done | failed | timeout
//   4. return the resulting Blossom hash + Wayback URL so the bookmark event
//      can be amended with archive tags.

import { api, type ArchiveStatus, type ArchivePurchaseResponse } from '$lib/api/client.js';
import { payInvoicesWithWebLN } from './zap.js';

export interface ArchiveOutcome {
  status: ArchiveStatus;
  preimage: string;
}

export interface ArchiveProgress {
  state: ArchiveStatus['state'];
  detail?: string;
}

/**
 * End-to-end purchase: invoice → WebLN payment → poll. Yields progress events
 * so the UI can show a live status. Throws on terminal failure.
 *
 * Polling cadence: 2s (matches the cadence the mockups display). Cap at
 * `timeoutMs` to avoid leaking sessions.
 */
export async function* purchaseArchive(opts: {
  url: string;
  tier: 'private' | 'public';
  pubkey: string;
  /** Skip the invoice + WebLN path when the caller has already confirmed
   *  the user is a lifetime member. Server double-checks via NIP-98. */
  lifetime?: boolean;
  timeoutMs?: number;
}): AsyncGenerator<ArchiveProgress, ArchiveOutcome, void> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;

  let jobId: string;
  let preimage: string;

  if (opts.lifetime) {
    yield { state: 'pending-payment', detail: 'enqueuing (free for lifetime members)…' };
    const result = await api.purchaseArchiveLifetime({ url: opts.url });
    jobId = result.jobId;
    preimage = ''; // no preimage — nothing was paid.
  } else {
    yield { state: 'pending-payment', detail: 'requesting invoice…' };
    const purchase: ArchivePurchaseResponse = await api.purchaseArchive({
      url: opts.url,
      tier: opts.tier,
      pubkey: opts.pubkey
    });

    yield { state: 'pending-payment', detail: `paying ${purchase.amountSats} sats…` };
    const preimages = await payInvoicesWithWebLN([
      {
        invoice: purchase.invoice,
        recipient: {
          label: 'deepmarks',
          lightning: '',
          millisats: purchase.amountSats * 1000
        }
      }
    ]);
    preimage = preimages[0];
    if (!preimage) throw new Error('Wallet returned no preimage for the archive payment.');
    jobId = purchase.jobId;
  }

  const POLL_INTERVAL_MS = 2000;
  const deadline = Date.now() + timeoutMs;
  // Sentinel — guarantees the first observed state is always emitted, even
  // if it happens to be 'queued'.
  let lastState: ArchiveStatus['state'] | null = null;
  while (Date.now() < deadline) {
    const pollStartedAt = Date.now();
    const status = await api.archiveStatus(jobId);
    if (status.state !== lastState) {
      yield {
        state: status.state,
        detail: status.state === 'failed' ? status.error : undefined
      };
      lastState = status.state;
    }
    if (status.state === 'done') return { status, preimage };
    if (status.state === 'failed') {
      throw new Error(status.error ?? 'archive job failed');
    }
    // Subtract fetch latency so the cadence stays close to POLL_INTERVAL_MS
    // even on slow networks.
    const elapsed = Date.now() - pollStartedAt;
    const wait = Math.max(0, POLL_INTERVAL_MS - elapsed);
    await new Promise((r) => setTimeout(r, wait));
  }
  throw new Error('archive job timed out — check /app/settings later');
}
