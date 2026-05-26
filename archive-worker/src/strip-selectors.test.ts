import { describe, it, expect } from 'vitest';
import { stripSelectorsForUrl } from './strip-selectors.js';

describe('stripSelectorsForUrl', () => {
  it('returns YouTube selectors for desktop watch URLs', () => {
    const sel = stripSelectorsForUrl('https://www.youtube.com/watch?v=abc123');
    expect(sel).toContain('#secondary');
    expect(sel).toContain('ytd-watch-next-secondary-results-renderer');
  });

  it('matches the apex youtube.com (no leading subdomain)', () => {
    const sel = stripSelectorsForUrl('https://youtube.com/watch?v=abc');
    expect(sel.length).toBeGreaterThan(0);
  });

  it('matches mobile m.youtube.com via the subdomain strip', () => {
    const sel = stripSelectorsForUrl('https://m.youtube.com/watch?v=abc');
    expect(sel).toContain('#secondary');
  });

  it('returns Twitter sidebar strip for both twitter.com and x.com', () => {
    const t = stripSelectorsForUrl('https://twitter.com/user/status/123');
    const x = stripSelectorsForUrl('https://x.com/user/status/123');
    expect(t).toContain('[data-testid="sidebarColumn"]');
    expect(x).toContain('[data-testid="sidebarColumn"]');
  });

  it('returns an empty list for hosts we have no rule for', () => {
    expect(stripSelectorsForUrl('https://example.com/article')).toEqual([]);
    expect(stripSelectorsForUrl('https://news.ycombinator.com/item?id=1')).toEqual([]);
  });

  it('tolerates malformed URLs without throwing', () => {
    expect(stripSelectorsForUrl('not a url')).toEqual([]);
    expect(stripSelectorsForUrl('')).toEqual([]);
  });

  it('does not return rules for hosts that just contain a known substring', () => {
    // youtube-clone.com shouldn't match youtube.com
    expect(stripSelectorsForUrl('https://youtube-clone.com/watch')).toEqual([]);
    // mythingytwitter.com shouldn't match twitter.com
    expect(stripSelectorsForUrl('https://mythingytwitter.com')).toEqual([]);
  });
});
