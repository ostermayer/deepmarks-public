import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bookmarkFiletype, bookmarkHasPdf, isScholarlyBookmark, parseQuery } from './search.js';

const normalizeTag = (tag: string) => tag.trim().toLowerCase().replace(/^#/, '');

describe('parseQuery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-24T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('parses the search syntax shown in the web and app help text', () => {
    const query = parseQuery(
      '#bitcoin site:paulgraham.com after:2024-01-01 before:2024-12-31 essay',
      normalizeTag,
    );

    expect(query).toMatchObject({
      q: 'essay',
      tags: ['bitcoin'],
      site: 'paulgraham.com',
      after: Date.parse('2024-01-01T00:00:00Z') / 1000,
      before: Date.parse('2024-12-31T00:00:00Z') / 1000,
    });
  });

  it('accepts uppercase date modifiers', () => {
    const query = parseQuery('AFTER:2024-01-01 BEFORE:2024-12-31', normalizeTag);

    expect(query.after).toBe(Date.parse('2024-01-01T00:00:00Z') / 1000);
    expect(query.before).toBe(Date.parse('2024-12-31T00:00:00Z') / 1000);
  });

  it('normalizes natural date phrases into explicit filters', () => {
    const query = parseQuery('show me my bookmarks from two years ago', normalizeTag);

    expect(query).toMatchObject({
      after: Date.parse('2024-01-01T00:00:00Z') / 1000,
      before: Date.parse('2025-01-01T00:00:00Z') / 1000,
    });
    expect(query.q).toBeUndefined();
  });

  it('keeps a standalone natural date phrase literal', () => {
    const query = parseQuery('from two years ago', normalizeTag);

    expect(query).toEqual({ q: 'from two years ago' });
  });

  it('keeps meaningful terms while normalizing natural dates', () => {
    const query = parseQuery('bitcoin from last year', normalizeTag);

    expect(query).toMatchObject({
      q: 'bitcoin',
      after: Date.parse('2025-01-01T00:00:00Z') / 1000,
      before: Date.parse('2026-01-01T00:00:00Z') / 1000,
    });
  });

  it('normalizes pdf and scholarly language into filters', () => {
    const query = parseQuery('creatine papers with pdfs', normalizeTag);

    expect(query).toMatchObject({
      q: 'creatine',
      hasPdf: true,
      scholarly: true,
    });
  });
});

describe('bookmark search facets', () => {
  it('detects direct PDF and /pdf URL shapes', () => {
    expect(bookmarkFiletype('https://example.com/report.pdf')).toBe('pdf');
    expect(bookmarkFiletype('https://pmc.ncbi.nlm.nih.gov/articles/PMC1/pdf')).toBe('pdf');
  });

  it('detects PDF-capable scholarly pages', () => {
    expect(bookmarkHasPdf('https://example.com/report.pdf')).toBe(true);
    expect(bookmarkHasPdf('https://pmc.ncbi.nlm.nih.gov/articles/PMC8838971/')).toBe(true);
    expect(bookmarkHasPdf('https://arxiv.org/abs/2401.12345')).toBe(true);
    expect(bookmarkHasPdf('https://example.com/article')).toBe(false);
  });

  it('detects scholarly-looking bookmarks', () => {
    expect(isScholarlyBookmark({
      url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC8838971/pdf/report.pdf',
      title: 'Creatine supplementation and mitochondrial dysfunction review',
      description: '',
      tags: ['medicine'],
    })).toBe(true);
    expect(isScholarlyBookmark({
      url: 'https://example.com/creatine-poster.pdf',
      title: 'Creatine workout poster',
      description: '',
      tags: [],
    })).toBe(false);
  });
});
