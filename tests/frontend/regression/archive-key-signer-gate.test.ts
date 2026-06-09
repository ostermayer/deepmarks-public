// Regression guard for audit finding ARCH-A1 (2026-06 review), FIXED:
// a private/media archive enqueued by a signer that can't do NIP-44
// orphaned its AES key in this device's localStorage forever — the key
// wrap could never publish, so the paid archive was undecryptable on
// every other device (and after any storage clear, everywhere). The
// enqueue now probes the signer first and fails loudly.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/api/client', () => ({
  api: { enqueueLifetimeArchive: vi.fn(), archiveStatus: vi.fn() },
  ApiError: class extends Error {},
}));

const archiveKeyMocks = vi.hoisted(() => ({
  addArchiveKeyToSet: vi.fn(),
  assertArchiveKeySignerReady: vi.fn(async () => undefined),
  clearPendingArchiveKey: vi.fn(),
  generateArchiveKey: vi.fn(() => 'A'.repeat(43) + '='),
  publishPendingArchiveKey: vi.fn(async () => undefined),
  stashPendingArchiveKey: vi.fn(),
}));
vi.mock('$lib/nostr/archive-keys.js', () => archiveKeyMocks);

import { enqueueArchivePage } from '$lib/nostr/archive.js';
import { api } from '$lib/api/client';

const PUBKEY = 'a'.repeat(64);

beforeEach(() => {
  vi.clearAllMocks();
  archiveKeyMocks.assertArchiveKeySignerReady.mockResolvedValue(undefined);
  (api.enqueueLifetimeArchive as ReturnType<typeof vi.fn>).mockResolvedValue({
    paymentHash: 'job1', jobId: 'job1', amountSats: 0,
  });
});

describe('private archive enqueue signer gate', () => {
  it('refuses a private enqueue when the signer cannot encrypt with nip44', async () => {
    archiveKeyMocks.assertArchiveKeySignerReady.mockRejectedValue(
      new Error('Your signer does not support NIP-44 encryption, which private archives need to sync their keys.'),
    );

    await expect(enqueueArchivePage({
      url: 'https://example.com/',
      tier: 'private',
      pubkey: PUBKEY,
      lifetime: true,
    })).rejects.toThrow(/NIP-44/);

    expect(api.enqueueLifetimeArchive).not.toHaveBeenCalled();
    expect(archiveKeyMocks.stashPendingArchiveKey).not.toHaveBeenCalled();
  });

  it('does not gate public archives (no key involved)', async () => {
    archiveKeyMocks.assertArchiveKeySignerReady.mockRejectedValue(new Error('nope'));

    await expect(enqueueArchivePage({
      url: 'https://example.com/',
      tier: 'public',
      pubkey: PUBKEY,
      lifetime: true,
    })).resolves.toMatchObject({ jobId: 'job1' });
  });
});
