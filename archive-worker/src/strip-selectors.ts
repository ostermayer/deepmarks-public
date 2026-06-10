// Per-host element-strip rules.
//
// Content-heavy pages (YouTube watch pages, Twitter threads, etc.)
// embed massive recommendation rails / "Who to follow" sidebars /
// related-content grids that the user wasn't bookmarking the page
// for. SingleFile faithfully inlines every <img> as base64, which is
// how a YouTube watch page balloons to ~60MB on capture (90% of it
// recommended-video thumbnails).
//
// For each known host we declare the CSS selectors to remove before
// SingleFile runs. The player chrome, title, description, and
// comments stay; the noise gets stripped. Failure mode is benign — a
// selector that no longer matches is a no-op, and the worker falls
// back to the full-page capture.

const STRIP_SELECTORS_BY_HOST: Record<string, string[]> = {
  // ── YouTube ────────────────────────────────────────────────────────
  // Right-rail recommendations (the main 60MB → 3MB driver), the
  // related-videos column on the watch page, and the legacy `#related`
  // block from older layouts. Player / title / description / comments
  // stay.
  'youtube.com': [
    '#secondary',
    '#secondary-inner',
    'ytd-watch-next-secondary-results-renderer',
    '#related',
    'ytd-merch-shelf-renderer',
    'ytd-popup-container',
  ],
  // ── Twitter / X ────────────────────────────────────────────────────
  // Strip the right column (trends, "Who to follow", suggested ads).
  // Tweet timeline + replies are in the main column and stay.
  'twitter.com': [
    '[data-testid="sidebarColumn"]',
  ],
  'x.com': [
    '[data-testid="sidebarColumn"]',
  ],
};

/**
 * Return the strip selectors that apply to `url`, or an empty array
 * when the host isn't known. Strips leading `www.` and `m.`
 * subdomains so mobile/desktop URLs share rules.
 */
export function stripSelectorsForUrl(url: string): string[] {
  try {
    let host = new URL(url).hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    else if (host.startsWith('m.')) host = host.slice(2);
    return STRIP_SELECTORS_BY_HOST[host] ?? [];
  } catch {
    return [];
  }
}
