import { describe, it, expect } from 'vitest';
import { detectFormat, findImporter } from './index.js';

describe('detectFormat', () => {
  it('picks Netscape for .html', () => {
    expect(detectFormat('export.html', '')?.id).toBe('netscape');
  });
  it('picks Pinboard for .json', () => {
    expect(detectFormat('pins.json', '[]')?.id).toBe('pinboard');
  });
  it('sniffs Pocket vs Instapaper vs Raindrop CSV by header', () => {
    expect(detectFormat('a.csv', 'title,url,time_added\n')?.id).toBe('pocket');
    expect(detectFormat('a.csv', 'URL,Title,Selection\n')?.id).toBe('instapaper');
    expect(detectFormat('a.csv', 'id,title,note,url\n')?.id).toBe('raindrop');
  });
  it('returns undefined for unknown extensions', () => {
    expect(detectFormat('mystery.txt', '')).toBeUndefined();
  });
});

describe('findImporter', () => {
  it('looks up by id', () => {
    expect(findImporter('netscape')?.id).toBe('netscape');
    expect(findImporter('nope')).toBeUndefined();
  });
});
