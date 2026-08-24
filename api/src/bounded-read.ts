// Bounded response-body readers — the one place the "stream chunks, never
// exceed the byte budget" loop lives. Every preview/oEmbed/Crossref/favicon
// fetch reads attacker-influenceable bodies; hand-copied read loops drifted
// (one favicon copy buffered the whole body before checking its size), so
// all callers go through these.

/** Read at most `maxBytes` of the body, slicing the final chunk so a single
 *  large frame can't overshoot the budget. Cancels the rest of the stream. */
export async function readBoundedBytes(res: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (received < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = maxBytes - received;
    const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
    chunks.push(chunk);
    received += chunk.byteLength;
    if (value.byteLength > remaining) break;
  }
  try {
    await reader.cancel();
  } catch {
    /* ignore */
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** `readBoundedBytes`, decoded as (lossy) UTF-8. */
export async function readBoundedText(res: Response, maxBytes: number): Promise<string> {
  return new TextDecoder('utf-8', { fatal: false }).decode(await readBoundedBytes(res, maxBytes));
}

/** Read the body only when it fits the budget: null when the declared
 *  content-length or the actual stream exceeds `maxBytes`. For payloads
 *  that are useless when truncated (favicons, images). */
export async function readBytesWithin(res: Response, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number.parseInt(res.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    return null;
  }
  // Ask for one byte over budget: hitting it means the body is oversized.
  const bytes = await readBoundedBytes(res, maxBytes + 1);
  return bytes.byteLength > maxBytes ? null : bytes;
}
