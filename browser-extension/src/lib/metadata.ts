// Metadata client for the Add screen.
//
// Calls api.deepmarks.org/metadata?url=... which scrapes title /
// description / suggestedTags server-side. We use it to backfill
// suggestedTags (the popup's readActiveTab() already gets title +
// description from the live DOM, which is more accurate than the
// server's scrape for SPAs and gated pages). Network errors are
// non-fatal — the user can still type tags by hand.

const API_BASE = 'https://api.deepmarks.org';

export interface UrlMetadata {
  url: string;
  title?: string;
  description?: string;
  suggestedTags: string[];
}

export async function fetchUrlMetadata(url: string): Promise<UrlMetadata | null> {
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname.includes('.')) return null;
  } catch {
    return null;
  }
  try {
    // enrich=0: the popup only uses suggestedTags (title/description come
    // from the live tab), and the caller's 3.5s timeout would usually drop
    // the response while the server ran its inline LLM round-trip anyway —
    // the saved bookmark still gets LLM-enriched by the backend pipeline.
    // Same fast-path choice as the iOS/Android share sheets.
    const res = await fetch(
      `${API_BASE}/metadata?url=${encodeURIComponent(trimmed)}&enrich=0`,
      { headers: { accept: 'application/json' } },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<UrlMetadata>;
    return {
      url: trimmed,
      title: body.title,
      description: body.description,
      suggestedTags: Array.isArray(body.suggestedTags) ? body.suggestedTags : [],
    };
  } catch {
    return null;
  }
}
