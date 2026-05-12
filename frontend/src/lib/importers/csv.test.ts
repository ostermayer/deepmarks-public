import { describe, it, expect } from 'vitest';
import { parseCsv } from './csv.js';

describe('parseCsv', () => {
  it('parses headers + simple rows', () => {
    expect(parseCsv('a,b,c\n1,2,3\n4,5,6')).toEqual([
      { a: '1', b: '2', c: '3' },
      { a: '4', b: '5', c: '6' }
    ]);
  });

  it('handles quoted fields with commas', () => {
    expect(parseCsv('a,b\n"hi, there","ok"')).toEqual([{ a: 'hi, there', b: 'ok' }]);
  });

  it('handles escaped double quotes', () => {
    expect(parseCsv('a\n"she said ""hi"""')).toEqual([{ a: 'she said "hi"' }]);
  });

  it('handles CR/LF line endings', () => {
    expect(parseCsv('a,b\r\n1,2\r\n3,4')).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' }
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(parseCsv('')).toEqual([]);
  });

  it('handles trailing newline without producing a blank row', () => {
    expect(parseCsv('a\n1\n')).toEqual([{ a: '1' }]);
  });
});
