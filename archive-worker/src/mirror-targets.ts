import { assertSafePublicHttpUrl, UnsafeUrlError } from './safe-url.js';

export interface MirrorTargetInput {
  primaryUrl: string;
  operatorUrls: string[];
  userUrls?: string[];
}

export interface MirrorTargetResult {
  urls: string[];
  rejected: Array<{ url: string; ok: false; error: string }>;
}

export async function resolveMirrorTargets(input: MirrorTargetInput): Promise<MirrorTargetResult> {
  const primary = originOrTrimmed(input.primaryUrl);
  const seen = new Set<string>([primary]);
  const urls: string[] = [];
  const rejected: Array<{ url: string; ok: false; error: string }> = [];
  const candidates = [
    ...input.operatorUrls,
    ...(input.userUrls ?? []),
  ];

  for (const raw of candidates) {
    let parsed: URL;
    try {
      parsed = await assertSafePublicHttpUrl(raw);
      if (parsed.protocol !== 'https:') throw new UnsafeUrlError('mirror must use https');
    } catch (err) {
      rejected.push({
        url: raw,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const normalized = parsed.origin.replace(/\/$/, '');
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    urls.push(normalized);
  }

  return { urls, rejected };
}

function originOrTrimmed(raw: string): string {
  try {
    return new URL(raw).origin.replace(/\/$/, '');
  } catch {
    return raw.replace(/\/$/, '');
  }
}
