import { describe, it, expect } from 'vitest';
import { buildPixelMonster } from './pixel-monster.js';

describe('buildPixelMonster', () => {
  const PUB = 'a'.repeat(64);

  it('is deterministic — same pubkey in always gives the same monster', () => {
    const a = buildPixelMonster(PUB);
    const b = buildPixelMonster(PUB);
    expect(a.body).toBe(b.body);
    expect(a.eye).toBe(b.eye);
    expect(a.background).toBe(b.background);
    expect(JSON.stringify(a.cells)).toBe(JSON.stringify(b.cells));
  });

  it('produces a 10×10 grid', () => {
    const m = buildPixelMonster(PUB);
    expect(m.size).toBe(10);
    expect(m.cells.length).toBe(10);
    for (const row of m.cells) {
      expect(row.length).toBe(10);
    }
  });

  it('contains the face features — every monster has body, eyes, and a mouth', () => {
    const flat = buildPixelMonster(PUB).cells.flat();
    expect(flat.filter((c) => c === 'body').length).toBeGreaterThan(10);
    expect(flat.filter((c) => c === 'eye').length).toBeGreaterThanOrEqual(1);
    expect(flat.filter((c) => c === 'mouth').length).toBeGreaterThanOrEqual(1);
  });

  it('differentiates between similar pubkeys', () => {
    const a = buildPixelMonster('0'.repeat(64));
    const b = buildPixelMonster('1' + '0'.repeat(63));
    // At least one of body template, body color, eye color, or bg differs.
    const same =
      a.body === b.body && a.eye === b.eye && a.background === b.background
      && JSON.stringify(a.cells) === JSON.stringify(b.cells);
    expect(same).toBe(false);
  });

  it('is symmetric — left half mirrors the right half', () => {
    const m = buildPixelMonster(PUB);
    for (let y = 0; y < m.size; y++) {
      for (let x = 0; x < m.size / 2; x++) {
        expect(m.cells[y][x]).toBe(m.cells[y][m.size - 1 - x]);
      }
    }
  });

  it('degrades gracefully on garbage input — still returns a usable monster', () => {
    const m = buildPixelMonster('not-a-pubkey');
    expect(m.cells.length).toBe(10);
    expect(m.body).toMatch(/^hsl/);
  });
});
