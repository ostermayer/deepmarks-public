// Raw signed Nostr events, one per line. This is the lossless, sovereignty
// export — the user can republish their entire bookmark set to any other
// Nostr client without re-signing or contacting Deepmarks again.
//
// Caller is responsible for handing in the *signed* events; we don't have
// access to the raw JSON of someone else's event from a parsed view, so this
// exporter takes a different shape than the others.

import type { SignedEventLike } from '$lib/nostr/bookmarks';

export function generateJsonl(events: SignedEventLike[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n');
}
