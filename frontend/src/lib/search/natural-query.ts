export interface NaturalSearchQuery {
  query: string;
  after?: number;
  before?: number;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

const MONTHS: Record<string, number> = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sep: 8,
  sept: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
};

const FILLER_WORDS = new Set([
  'all',
  'an',
  'and',
  'are',
  'a',
  'bookmark',
  'bookmarks',
  'find',
  'for',
  'from',
  'get',
  'give',
  'i',
  'in',
  'is',
  'links',
  'link',
  'list',
  'me',
  'my',
  'of',
  'on',
  'please',
  'saved',
  'saves',
  'search',
  'show',
  'that',
  'the',
  'were',
  'with',
]);

const NUMBER_PATTERN = '(\\d+|one|two|three|four|five|six|seven|eight|nine|ten)';
const MONTH_PATTERN = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join('|');

export function normalizeNaturalSearchQuery(raw: string, nowMs = Date.now()): NaturalSearchQuery {
  let residual = raw;
  let after: number | undefined;
  let before: number | undefined;
  const now = new Date(nowMs);
  const hasDateIntent = hasNaturalDateIntent(raw);

  const setRange = (start?: number, end?: number): void => {
    if (start !== undefined) after = start;
    if (end !== undefined) before = end;
  };

  const consume = (pattern: RegExp, handler: (match: RegExpExecArray) => void): void => {
    const match = pattern.exec(residual);
    if (!match) return;
    handler(match);
    residual = residual.slice(0, match.index) + ' ' + residual.slice(match.index + match[0].length);
  };

  consume(new RegExp(`\\b(?:from|in|during)?\\s*(${MONTH_PATTERN})\\s+((?:19|20)\\d{2})\\b`, 'i'), (match) => {
    const monthName = match[1]?.toLowerCase() ?? '';
    const year = Number.parseInt(match[2] ?? '', 10);
    const month = MONTHS[monthName];
    if (month === undefined || !Number.isFinite(year)) return;
    setRange(utcSeconds(year, month, 1), utcSeconds(year, month + 1, 1));
  });

  consume(/\b(?:from|in|during)\s+((?:19|20)\d{2})\b/i, (match) => {
    const year = Number.parseInt(match[1] ?? '', 10);
    if (!Number.isFinite(year)) return;
    setRange(utcSeconds(year, 0, 1), utcSeconds(year + 1, 0, 1));
  });

  consume(new RegExp(`\\b(?:from|in|during)?\\s*${NUMBER_PATTERN}\\s+years?\\s+ago\\b`, 'i'), (match) => {
    const count = numberValue(match[1]);
    if (!count) return;
    const year = now.getUTCFullYear() - count;
    setRange(utcSeconds(year, 0, 1), utcSeconds(year + 1, 0, 1));
  });

  consume(new RegExp(`\\bolder\\s+than\\s+${NUMBER_PATTERN}\\s+(days?|weeks?|months?|years?)\\b`, 'i'), (match) => {
    const count = numberValue(match[1]);
    if (!count) return;
    setRange(undefined, shift(now, match[2] ?? '', -count));
  });

  consume(new RegExp(`\\b(?:past|last)\\s+${NUMBER_PATTERN}\\s+(days?|weeks?|months?|years?)\\b`, 'i'), (match) => {
    const count = numberValue(match[1]);
    if (!count) return;
    setRange(shift(now, match[2] ?? '', -count), undefined);
  });

  consume(/\bthis\s+(week|month|year)\b/i, (match) => {
    setRange(periodStart(now, match[1] ?? ''), undefined);
  });

  consume(/\blast\s+(week|month|year)\b/i, (match) => {
    const unit = match[1] ?? '';
    setRange(previousPeriodStart(now, unit), periodStart(now, unit));
  });

  consume(/\byesterday\b/i, () => {
    const today = dayStart(now);
    setRange(today - 86_400, today);
  });

  consume(/\btoday\b/i, () => {
    setRange(dayStart(now), undefined);
  });

  const contentModifiers: string[] = [];
  consume(/\bpdfs?\b/i, () => {
    if (!/\b(?:filetype|type|has):/i.test(raw)) contentModifiers.push('has:pdf');
  });
  consume(/\b(?:scholarly\s+works?|academic(?:\s+papers?)?|research\s+papers?|journal\s+articles?|papers|studies)\b/i, () => {
    if (!/\bscholarly:/i.test(raw)) contentModifiers.push('scholarly:yes');
  });

  const plain = residual
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .filter((token) => isModifier(token) || !FILLER_WORDS.has(token.toLowerCase()));

  const hasRange = after !== undefined || before !== undefined;
  const hasResidualSearch = plain.length > 0;
  if (hasRange && !hasDateIntent && !hasResidualSearch) {
    return { query: raw.trim() };
  }

  const generated: string[] = [];
  if (!/\bafter:/i.test(raw) && after !== undefined) generated.push(`after:${isoDate(after)}`);
  if (!/\bbefore:/i.test(raw) && before !== undefined) generated.push(`before:${isoDate(before)}`);

  return {
    query: [...generated, ...contentModifiers, ...plain].join(' ').trim(),
    after,
    before,
  };
}

function numberValue(raw: string | undefined): number | null {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
  return NUMBER_WORDS[raw.toLowerCase()] ?? null;
}

function isModifier(token: string): boolean {
  return token.startsWith('#') || /^[a-z]+:/i.test(token);
}

function hasNaturalDateIntent(raw: string): boolean {
  return /\b(?:show|find|search|list|get|give)\b/i.test(raw) ||
    /\b(?:bookmarks?|links?|saved|saves)\b/i.test(raw);
}

function utcSeconds(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month, day) / 1000);
}

function dayStart(date: Date): number {
  return utcSeconds(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function periodStart(date: Date, unit: string): number {
  if (unit === 'week') {
    const start = dayStart(date);
    const day = date.getUTCDay() || 7;
    return start - (day - 1) * 86_400;
  }
  if (unit === 'month') return utcSeconds(date.getUTCFullYear(), date.getUTCMonth(), 1);
  return utcSeconds(date.getUTCFullYear(), 0, 1);
}

function previousPeriodStart(date: Date, unit: string): number {
  if (unit === 'week') return periodStart(date, 'week') - 7 * 86_400;
  if (unit === 'month') return utcSeconds(date.getUTCFullYear(), date.getUTCMonth() - 1, 1);
  return utcSeconds(date.getUTCFullYear() - 1, 0, 1);
}

function shift(date: Date, unit: string, amount: number): number {
  const next = new Date(date.getTime());
  if (unit.startsWith('day')) next.setUTCDate(next.getUTCDate() + amount);
  else if (unit.startsWith('week')) next.setUTCDate(next.getUTCDate() + amount * 7);
  else if (unit.startsWith('month')) next.setUTCMonth(next.getUTCMonth() + amount);
  else next.setUTCFullYear(next.getUTCFullYear() + amount);
  return Math.floor(next.getTime() / 1000);
}

function isoDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}
