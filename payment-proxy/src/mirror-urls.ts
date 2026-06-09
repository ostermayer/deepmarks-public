import { validateSafePublicHttpUrl } from './safe-url.js';

export function normalizeMirrorUrls(input: unknown): { ok: true; urls: string[] } | { ok: false; error: string } {
  if (input === undefined) return { ok: true, urls: [] };
  if (!Array.isArray(input)) return { ok: false, error: 'mirrorUrls must be an array' };
  if (input.length > 8) return { ok: false, error: 'mirrorUrls supports up to 8 backup Blossom servers' };

  const urls: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== 'string') return { ok: false, error: 'mirrorUrls entries must be strings' };
    if (raw.length > 500) return { ok: false, error: 'mirrorUrls entries are too long' };
    let parsed: URL;
    try {
      parsed = validateSafePublicHttpUrl(raw);
    } catch {
      return { ok: false, error: 'mirrorUrls must be public https Blossom server URLs' };
    }
    if (parsed.protocol !== 'https:') {
      return { ok: false, error: 'mirrorUrls must use https' };
    }
    const origin = parsed.origin.replace(/\/$/, '');
    if (!seen.has(origin)) {
      seen.add(origin);
      urls.push(origin);
    }
  }
  return { ok: true, urls };
}
