import { describe, it, expect } from 'vitest';
import { isParameterizedReplaceable } from './publish.js';

describe('isParameterizedReplaceable', () => {
  it('returns true for kinds in [30000, 40000) with a d-tag', () => {
    expect(
      isParameterizedReplaceable({
        kind: 30003,
        created_at: 0,
        tags: [['d', 'set-name']],
        content: ''
      })
    ).toBe(true);
    expect(
      isParameterizedReplaceable({
        kind: 39701,
        created_at: 0,
        tags: [['d', 'https://x']],
        content: ''
      })
    ).toBe(true);
  });

  it('returns false for in-range kinds without a d-tag', () => {
    expect(
      isParameterizedReplaceable({
        kind: 30003,
        created_at: 0,
        tags: [['title', 'oops']],
        content: ''
      })
    ).toBe(false);
  });

  it('returns false for ephemeral / non-replaceable kinds', () => {
    expect(
      isParameterizedReplaceable({
        kind: 1,
        created_at: 0,
        tags: [['d', 'unused']],
        content: ''
      })
    ).toBe(false);
    expect(
      isParameterizedReplaceable({
        kind: 9735,
        created_at: 0,
        tags: [],
        content: ''
      })
    ).toBe(false);
  });

  it('returns false when the d-tag value is missing or non-string', () => {
    expect(
      isParameterizedReplaceable({
        kind: 30003,
        created_at: 0,
        tags: [['d']],
        content: ''
      })
    ).toBe(false);
  });
});
