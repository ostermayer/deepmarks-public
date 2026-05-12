// Helper for any feed that streams in over a Nostr subscription: pin the
// list to a snapshot shortly after it first populates so the page doesn't
// reshuffle under the reader. New events accumulate into a `pending`
// count; the caller surfaces a banner and calls `flush()` to reveal them.
//
// Used by BookmarkList (generic bookmark feeds) and by the landing page
// which renders LandingFeedRow directly without going through BookmarkList.

import { derived, writable, type Readable } from 'svelte/store';

export interface FrozenFeed<T extends { eventId: string }> {
  /** The visible list — frozen once the settle-delay elapses. Pre-freeze,
   *  this passes `source` through unchanged. */
  visible: Readable<T[]>;
  /** Count of source items that aren't in the current visible snapshot. */
  pending: Readable<number>;
  /** Copy the current source into the visible snapshot. */
  flush: () => void;
  /** Tear down the settle timer (call from onDestroy). */
  dispose: () => void;
}

/**
 * @param source   reactive feed store
 * @param delayMs  wait this long after the first non-empty source value
 *                 before snapshotting (default 800ms — roughly EOSE)
 */
export function freezeFeed<T extends { eventId: string }>(
  source: Readable<T[]>,
  delayMs = 800,
): FrozenFeed<T> {
  const frozen = writable<T[] | null>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let currentSource: T[] = [];

  const unsubSource = source.subscribe((val) => {
    currentSource = val;
    if (val.length > 0 && !timer) {
      timer = setTimeout(() => {
        frozen.set([...val]);
        timer = null;
      }, delayMs);
    }
  });

  const visible: Readable<T[]> = derived([source, frozen], ([$s, $f]) => $f ?? $s);
  const pending: Readable<number> = derived([source, frozen], ([$s, $f]) => {
    if (!$f) return 0;
    const seen = new Set($f.map((x) => x.eventId));
    let count = 0;
    for (const x of $s) if (!seen.has(x.eventId)) count++;
    return count;
  });

  return {
    visible,
    pending,
    flush: () => frozen.set([...currentSource]),
    dispose: () => {
      unsubSource();
      if (timer) { clearTimeout(timer); timer = null; }
    },
  };
}
