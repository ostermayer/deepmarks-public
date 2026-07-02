/**
 * Human-friendly "N minutes ago" from a Unix timestamp (seconds).
 *
 * Deliberately locale-static for MVP — every mockup reads in US English, and
 * swapping in `Intl.RelativeTimeFormat` later is a one-file change.
 *
 * `now()` is injectable so tests don't need to stub Date.
 */
export function relativeTime(
  unixSeconds: number,
  now: () => number = Date.now,
): string {
  if (!unixSeconds) return 'never';
  const seconds = Math.floor(now() / 1000) - unixSeconds;
  if (seconds < 0) return 'just now';
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
  if (seconds < 86400 * 2) return 'yesterday';
  if (seconds < 86400 * 14) return `${Math.floor(seconds / 86400)} days ago`;
  return new Date(unixSeconds * 1000).toLocaleDateString();
}
