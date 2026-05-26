import { api, type UrlMetadata } from '$lib/api/client';

type CachedPreview = Promise<UrlMetadata | null>;

const previewCache = new Map<string, CachedPreview>();
const INITIAL_TOKENS = 5;
const MAX_TOKENS = 10;
const REFILL_MS = 4_000;

let tokens = INITIAL_TOKENS;
let refillTimer: ReturnType<typeof setInterval> | null = null;
const queue: Array<() => void> = [];

export function loadUrlPreview(url: string): Promise<UrlMetadata | null> {
  const normalized = normalizePreviewUrl(url);
  if (!normalized) return Promise.resolve(null);
  const cached = previewCache.get(normalized);
  if (cached) return cached;

  const pending = schedulePreviewFetch(normalized);
  previewCache.set(normalized, pending);
  return pending;
}

function normalizePreviewUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function schedulePreviewFetch(url: string): CachedPreview {
  ensureRefillTimer();
  return new Promise((resolve) => {
    queue.push(() => {
      void api.metadata(url)
        .then(resolve)
        .catch(() => resolve(null));
    });
    drainQueue();
  });
}

function ensureRefillTimer(): void {
  if (refillTimer || typeof window === 'undefined') return;
  refillTimer = setInterval(() => {
    tokens = Math.min(MAX_TOKENS, tokens + 1);
    drainQueue();
  }, REFILL_MS);
}

function drainQueue(): void {
  while (tokens > 0 && queue.length > 0) {
    tokens -= 1;
    const run = queue.shift();
    run?.();
  }
}
