import { api } from '$lib/api/client';
import { primeEvents } from './event-resolver.js';
import type { ImportedNoteRef } from './imported-bookmarks.js';

const MAX_IDS_PER_RUN = 5_000;
const CHUNK_SIZE = 500;

let lastSignature = '';
let inFlight: Promise<void> | null = null;
let queued: { ids: string[]; relays: string[]; signature: string } | null = null;

export function maybePrefetchPrivateNip51NoteTargets(
  pubkey: string | null | undefined,
  refs: ImportedNoteRef[],
): void {
  // Public refs used to rely entirely on the server having mirrored the
  // target already — in the gap, the posts tab rendered placeholders all
  // session even when the e-tag carried perfectly good relay hints.
  // Prime BOTH visibilities through the same pipeline.
  if (!pubkey) return;
  if (refs.length === 0) return;

  const ids = Array.from(new Set(
    refs
      .map((ref) => ref.targetEventId.toLowerCase())
      .filter((id) => /^[0-9a-f]{64}$/.test(id)),
  )).slice(0, MAX_IDS_PER_RUN);
  if (ids.length === 0) return;

  const relays = Array.from(new Set(
    refs.flatMap((ref) => ref.relayHints ?? []),
  ));
  const signature = `${pubkey}:${ids.join(',')}:${relays.join(',')}`;
  if (signature === lastSignature) return;
  if (inFlight) {
    queued = { ids, relays, signature };
    return;
  }
  startPrefetch(ids, relays, signature);
}

function startPrefetch(ids: string[], relays: string[], signature: string): void {
  lastSignature = signature;
  inFlight = runPrefetch(ids, relays)
    .catch(() => {
      // Best effort. NoteCard still resolves anything already on our relay.
    })
    .finally(() => {
      inFlight = null;
      const next = queued;
      queued = null;
      if (next && next.signature !== lastSignature) {
        startPrefetch(next.ids, next.relays, next.signature);
      }
    });
}

async function runPrefetch(ids: string[], relays: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    const chunk = ids.slice(i, i + CHUNK_SIZE);
    await api.prefetchSocialBookmarkTargets({ eventIds: chunk, relays });
    await primeEvents(chunk);
  }
}
