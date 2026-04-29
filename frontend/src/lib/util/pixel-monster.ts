// Deterministic 16-bit monster / alien avatar.
//
// Given a pubkey we pick a body silhouette, an eye style, a mouth style,
// and an optional antenna from small hand-drawn templates. Colors come
// from a vibrant arcade palette so even nearby pubkeys read as different
// creatures. Pure — same pubkey always produces the same monster.
//
// Grid is 10×10; each cell is a kind. The Avatar renders each kind with
// its mapped color. Horizontally symmetric so it reads as a "face".

export type CellKind = 'empty' | 'body' | 'eye' | 'mouth' | 'antenna';

export interface PixelMonster {
  size: number;
  cells: CellKind[][];
  body: string;
  eye: string;
  mouth: string;
  background: string;
}

// ── raw templates ──────────────────────────────────────────────────────
//
// '.' = empty, 'B' = body, 'E' = eye, 'M' = mouth, 'A' = antenna.
// Each template is 10 rows of 10 cells. Templates are symmetric — the
// left half is authored and the right half is mirrored at build-time.
//
// The antenna row(s) are baked into each body so different silhouettes
// can have distinct headgear (horns vs tentacles vs spikes).

const BODIES = [
  // 0 — classic blob
  [
    '..........',
    '..........',
    '...BBBB...',
    '..BBBBBB..',
    '.BBEBBEBB.',
    '.BBBBBBBB.',
    '.BBBMMBBB.',
    '.BBBBBBBB.',
    '..BBBBBB..',
    '..BB..BB..',
  ],
  // 1 — tall alien with antennae
  [
    '...A..A...',
    '..AA..AA..',
    '..BBBBBB..',
    '.BBBBBBBB.',
    '.BEBBBBEB.',
    '.BBBBBBBB.',
    '.BBMMMMBB.',
    '.BBBBBBBB.',
    '..BBBBBB..',
    '..B.BB.B..',
  ],
  // 2 — wide beastie with horns
  [
    '..A....A..',
    '.AA....AA.',
    'BBBBBBBBBB',
    'BBBBBBBBBB',
    'BBEBBBBEBB',
    'BBBBBBBBBB',
    'BBBMMMMBBB',
    'BBBBBBBBBB',
    '.BBBBBBBB.',
    '.BB....BB.',
  ],
  // 3 — ghostie
  [
    '..........',
    '...BBBB...',
    '..BBBBBB..',
    '.BBBBBBBB.',
    '.BEBBBBEB.',
    '.BBBBBBBB.',
    '.BBMMMMBB.',
    '.BBBBBBBB.',
    '.BBBBBBBB.',
    '.B.B.B.B.B',
  ],
  // 4 — single-eye cyclops (eye slot on center col)
  [
    '....AA....',
    '...AAAA...',
    '..BBBBBB..',
    '.BBBBBBBB.',
    '.BBBEEBBB.',
    '.BBBBBBBB.',
    '.BBMMMMBB.',
    '.BBBBBBBB.',
    '..BBBBBB..',
    '..BB..BB..',
  ],
  // 5 — spikey
  [
    'A.A.AA.A.A',
    '.AAAAAAAAA',
    '..BBBBBB..',
    '.BBBBBBBB.',
    'BBEBBBBEBB',
    'BBBBBBBBBB',
    'BBBMBBMBBB',
    'BBBBBBBBBB',
    '.BBBBBBBB.',
    '..B....B..',
  ],
  // 6 — stubby pal
  [
    '..........',
    '..........',
    '..BBBBBB..',
    '.BBBBBBBB.',
    'BBBEBBEBBB',
    'BBBBBBBBBB',
    'BBBBMMBBBB',
    'BBBBBBBBBB',
    '.BBBBBBBB.',
    '.BB....BB.',
  ],
  // 7 — tentacle top
  [
    '.A...A....',
    'AAA.AAA...',
    '.BBBBBB...',
    'BBBBBBBB..',
    'BEBBBBEB..',
    'BBBBBBBB..',
    'BBBMMBBB..',
    'BBBBBBBB..',
    '.BBBBBB...',
    '.B.BB.B...',
  ],
];

const PALETTE_BODY = [
  'hsl(120 55% 45%)', // alien green
  'hsl(280 55% 60%)', // monster purple
  'hsl(190 70% 50%)', // cyan
  'hsl(30 85% 55%)',  // orange
  'hsl(340 70% 60%)', // pink
  'hsl(50 90% 55%)',  // yellow-green
  'hsl(220 65% 60%)', // periwinkle blue
  'hsl(0 65% 55%)',   // red devil
];

const PALETTE_EYE = [
  'hsl(0 0% 100%)',   // white
  'hsl(60 90% 70%)',  // lemon
  'hsl(190 80% 85%)', // ice blue
  'hsl(30 90% 75%)',  // peach
];

const PALETTE_BG = [
  'hsl(220 30% 95%)',
  'hsl(280 25% 95%)',
  'hsl(120 25% 95%)',
  'hsl(30 30% 95%)',
];

function hexNibble(c: string): number {
  const n = parseInt(c, 16);
  return Number.isFinite(n) ? n : 0;
}

function pick<T>(arr: readonly T[], seed: number): T {
  return arr[seed % arr.length];
}

function parseTemplate(rows: readonly string[]): CellKind[][] {
  return rows.map((row) => {
    const cells: CellKind[] = new Array(10).fill('empty');
    for (let x = 0; x < 10; x++) {
      const ch = row.charAt(x);
      cells[x] = ch === 'B' ? 'body'
               : ch === 'E' ? 'eye'
               : ch === 'M' ? 'mouth'
               : ch === 'A' ? 'antenna'
               : 'empty';
    }
    return cells;
  });
}

/**
 * Build the monster for a pubkey. Consumes 4 hex chars (16 bits):
 *   bits 0–3  body template choice (8 bodies)
 *   bits 4–7  body color (8 palette entries)
 *   bits 8–9  eye color (4)
 *   bits 10–11 bg color (4)
 *   bits 12–15 spare for future variants (accessory slots etc.)
 */
export function buildPixelMonster(pubkey: string): PixelMonster {
  const safe = /^[0-9a-f]+$/i.test(pubkey) ? pubkey.toLowerCase() : '0'.repeat(64);
  const seed = safe.padEnd(4, '0');

  const bodyIdx = hexNibble(seed[0]);
  const bodyColor = pick(PALETTE_BODY, hexNibble(seed[1]));
  const eyeColor = pick(PALETTE_EYE, hexNibble(seed[2]));
  const bgColor = pick(PALETTE_BG, hexNibble(seed[3]));

  const cells = parseTemplate(BODIES[bodyIdx % BODIES.length]);

  return {
    size: 10,
    cells,
    body: bodyColor,
    eye: eyeColor,
    mouth: 'hsl(0 0% 10%)', // near-black mouth for readability
    background: bgColor,
  };
}
