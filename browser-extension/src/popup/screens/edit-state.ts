// Recent → Add handoff for the edit-existing-bookmark flow.
//
// The popup router only carries a screen name. To pass "edit this
// specific bookmark" state we use the same in-memory module pattern
// as saved-state.ts: Recent's edit button writes here, Add reads on
// mount, and Add clears after consuming.

export interface EditTarget {
  url: string;
  title: string;
  description: string;
  tags: string[];
  archived: boolean;
  visibility: 'private' | 'public';
  /** Original event id, only meaningful for public bookmarks (so we
   *  know what to chain off). Private bookmarks live in the NIP-51
   *  set keyed by URL — no event id to track. */
  eventId?: string;
}

let pending: EditTarget | null = null;

export function setEditTarget(t: EditTarget): void { pending = t; }
export function takeEditTarget(): EditTarget | null {
  const t = pending;
  pending = null;
  return t;
}
