// In-memory hand-off between Add → Saved screen.
//
// The popup is a single page with a tiny in-memory router; we don't
// have URL params to pass state between screens. This module is just
// a module-level holder that Add writes and Saved reads.

import type { PublishFailure } from '../../lib/nostr.js';

export interface SavedHandoff {
  url: string;
  title: string;
  host: string;
  eventId: string;
  relayResults: { ok: string[]; failed: PublishFailure[] };
  archive: boolean;
  /** 'private' = went into the user's NIP-51 encrypted set;
   *  'public' = published as kind:39701 to the user's write relays. */
  visibility: 'private' | 'public';
  /** Set later by Saved when it kicks off the archive job. */
  archivePaymentHash?: string;
}

let last: SavedHandoff | null = null;

export function setLastSaved(s: SavedHandoff): void { last = s; }
export function getLastSaved(): SavedHandoff | null { return last; }
export function patchLastSaved(p: Partial<SavedHandoff>): void {
  if (last) last = { ...last, ...p };
}
