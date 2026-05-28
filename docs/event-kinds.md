# The Nostr event kinds Deepmarks uses for bookmarks

Deepmarks builds bookmarking and friend-scoped discovery on top of a
small set of standard Nostr event kinds.
Understanding what they are, why they're separate, and how they're
shaped is the easiest way to reason about anything in the codebase
touching `publish.ts`, `addToPrivateSet`, the strfry writePolicy, or
the relay-fanout worker.

| Kind   | NIP    | What it carries                                  | Created by |
|--------|--------|--------------------------------------------------|------------|
| 39701  | NIP-B0 | One event per public web bookmark (URL-keyed)    | Deepmarks-native |
| 10003  | NIP-51 | Single-replaceable bookmark list (notes + URLs)  | Damus / Primal / Amethyst / Snort |
| 30000  | NIP-51 | Categorized follow sets (`deepmarks-friends`)    | Deepmarks-native + third-party |
| 30003  | NIP-51 | Generic encrypted bookmark sets (chunked)        | Deepmarks-native + third-party |

## kind:39701 — public bookmarks (NIP-B0)

One event per public bookmark. The URL is the addressable key — saving
the same page twice replaces the previous event rather than creating a
new one.

```jsonc
{
  "kind": 39701,
  "pubkey": "<author hex>",
  "created_at": 1779100000,
  "tags": [
    ["d",            "https://example.com/article"],   // ← the URL = addressable key
    ["title",        "How to Cook a Brisket"],
    ["description",  "long-and-low method, 14 hours at 225°F"],
    ["published_at",    "1779100000"],    // user save time; stable sort key
    ["published_at_ms", "1779100000123"], // optional tie-breaker for rapid saves
    ["t",            "bbq"],
    ["t",            "recipes"],
    ["archive-tier", "forever"],         // optional, set when archived
    ["blossom",      "<sha256 hash>"],    // optional, Blossom blob hash
    ["wayback",      "https://web.archive.org/web/…"]   // optional
  ],
  "content": "",
  "sig": "<64-byte signature>"
}
```

Properties:

- **Addressable replaceable** — kind falls in the 30000–39999 range,
  so per [NIP-01] §"replaceable events" the relay keeps only the
  newest event per `(pubkey, kind, d-tag)` triple. Same URL saved
  twice ⇒ the older event is dropped automatically.
- **No content** — everything is in tags. The empty `content` keeps
  payloads small and makes the event grep-able.
- **Anyone can read** — public. Anyone with the relay URL can pull
  every kind:39701 event for any author.
- **Anyone can sign** — but our writePolicy only persists events
  whose author is in `dm:registered:pubkeys`, the relay allowlist used
  for Deepmarks users and followed curators mirrored by the server-side
  outbox worker.
- **Bookmark time is stable** — `published_at` records when the user
  saved/imported the bookmark. Edits and archive jobs keep that time.
  `published_at_ms` is Deepmarks-specific, optional, and accepted only
  when it is inside the same second as `published_at`; it preserves the
  order of multiple same-second saves.

The frontend's `buildBookmarkEvent` (`lib/nostr/bookmarks.ts`) produces
this shape; the backend's `bookmarkEventToJson` (`api-helpers.ts`)
reads it back.

## kind:30003 — private bookmark sets (NIP-51)

Generic encrypted list. Deepmarks uses it for **two** distinct things:

### A) The user's private bookmarks

Stored as **chunked** encrypted lists because NIP-44 v2 caps plaintext
at ~65 KB and a heavy bookmarker has thousands of entries:

```jsonc
{
  "kind": 30003,
  "pubkey": "<author hex>",
  "created_at": 1779100000,
  "tags": [
    ["d",                "deepmarks-private-7"],          // ← chunk identifier
    ["dm-set-version",   "e02b5fee-b5b5-4436-…"],         // groups chunks together
    ["dm-set-count",     "23"]                            // total chunks in this version
  ],
  "content": "<NIP-44 v2 ciphertext, base64>",
  "sig": "<64-byte signature>"
}
```

The set is split into N chunks. Chunk 0 is `d=deepmarks-private`,
chunks 1..N-1 are `d=deepmarks-private-<i>`. All chunks in one
version share the same `dm-set-version` UUID and `dm-set-count`.

Decrypting one chunk yields JSON like:

```json
[
  [["d","https://en.wikipedia.org/wiki/Mole_sauce"],
   ["title","Mole sauce — Wikipedia"],
   ["t","cooking"]],
  [["d","https://news.ycombinator.com/item?id=39000000"],
   ["title","Show HN: …"]],
  …
]
```

i.e. each entry is itself a tag array shaped like a kind:39701 event's
tags, including `published_at` / `published_at_ms` for stable sort
order. The selector in `private-bookmarks.ts`
(`selectCompletePrivateSetEvents`) fetches all chunks for the latest
complete version and assembles them.

- **Encrypted to self** — `nip44.encrypt(plaintext, getConversationKey(sk, pk))`
  where `sk` and `pk` are both the user's. The author is the only
  party who can decrypt. The relay sees only opaque ciphertext.
- **Addressable replaceable** — same chunk d-tag replaces. Editing a
  bookmark republishes the entire chunk that contains it.
- **Chunk count adapts** — adding a bookmark might push the new chunk
  count to 24; old chunk-23 from the previous version becomes an
  orphan and is ignored by the selector.

### B) The archive-keys set

A second kind:30003 set with `d=deepmarks-archive-keys`. Same
chunking pattern. Maps each archived blob hash to its per-blob AES
decryption key:

```json
{"<blob-hash-1>": "<base64 AES key>", "<blob-hash-2>": "<base64 AES key>", …}
```

Lets a user decrypt private archives on any device they're signed in
on without the AES keys ever crossing a server boundary.

## kind:10003 — social-post bookmark list (NIP-51, legacy)

The original NIP-51 bookmark list: a single replaceable event per
author (no `d` tag, just kind 10003 + pubkey identifies it). Damus,
Primal, Amethyst, and Snort all use this when a user taps "bookmark"
on a kind:1 note.

```jsonc
{
  "kind": 10003,
  "pubkey": "<author hex>",
  "created_at": 1779100000,
  "tags": [
    ["e", "<note event id>"],         // bookmarked note
    ["e", "<another note event id>"],
    ["a", "30023:<pubkey>:<d-tag>"],  // addressable replaceable (long-form, etc.)
    ["r", "https://example.com"],     // URL pin
    ["t", "to-read"]                  // hashtag
  ],
  "content": "",
  "sig": "<64-byte signature>"
}
```

Properties:

- **Single replaceable** — kind 10000–19999 is the simple
  replaceable range (no `d` tag), so each author has at most one
  kind:10003 at any time. New publishes overwrite the previous.
- **Heterogeneous content** — `e` tags point to Nostr notes,
  `a` tags to addressable events (long-form articles, etc.), `r`
  tags to web URLs, `t` to hashtags.
- **No encryption** — the standard kind:10003 is public. (Damus
  also supports an encrypted variant via NIP-44; Deepmarks
  currently treats them all as public.)

Deepmarks treats kind:10003 as **social-post bookmarks** — the
frontend's `createImportedNoteRefsFeed` turns each `e` tag into one
note reference shown in `/app/posts`. The onboarding scanner pulls
the user's existing kind:10003 when they register so their pinned
notes from Damus / Primal show up the moment they sign in. After
that, the writePolicy keeps accepting their kind:10003 publishes
from any client, and the fanout worker propagates them to the
user's NIP-65 write relays.

## kind:30000 — friends follow set (NIP-51)

Deepmarks friends are a selected subset of the user's normal NIP-02
contact list. The portable follow graph remains `kind:3`; the friends
feed uses a public NIP-51 follow set:

```jsonc
{
  "kind": 30000,
  "pubkey": "<author hex>",
  "created_at": 1779100000,
  "tags": [
    ["d", "deepmarks-friends"],
    ["title", "Deepmarks friends"],
    ["p", "<friend pubkey>"],
    ["p", "<friend pubkey>"]
  ],
  "content": "",
  "sig": "<64-byte signature>"
}
```

Properties:

- **Addressable replaceable** — each author has one current
  `deepmarks-friends` set.
- **Protocol-native subset** — other clients can read it as a normal
  NIP-51 follow set; Deepmarks does not invent a custom friend kind.
- **No multi-writer semantics** — the set is signed by its owner only.
  Collaborative collection editing is intentionally not modeled as
  multiple users mutating one replaceable event.

## Why this split

- **Public bookmarks need to be queryable**, indexable, shareable,
  searchable, zappable, replyable. Per-event addressing (kind:39701)
  makes all of that trivial.
- **Private bookmarks need bulk encryption** — encrypting one event
  per entry would balloon to thousands of relay events per user.
  One encrypted set, chunked, gives the same security with a much
  smaller event count.
- **The split matches Nostr conventions** — kind:39701 follows the
  NIP-B0 web-bookmark draft; kind:30003 + kind:10003 are the
  established NIP-51 list kinds.

## How they flow through the Deepmarks pipeline

```
client save (web app / iOS / browser extension / third-party Damus etc.)
   ↓
buildBookmarkEvent / addToPrivateSet / NIP-51 list builder
   ↓
sign locally, then POST signed event(s) to api.deepmarks.org/publish
   ↓
payment-proxy queues and forwards to relay.deepmarks.org
   ↓
strfry writePolicy checks dm:registered:pubkeys
(relay-allowed pubkeys, not a logged-in-user count)
   ↓ accept
strfry persists
   ↓
relay-fanout worker reads supported user-authored kinds from strfry
   ↓
publishes to each author's NIP-65 write relays
   ↓
Damus / Primal / nos.lol etc. see the event
```

For new registrations the onboarding scanner runs the reverse pass:
it queries the user's NIP-65 set for any pre-existing kind:39701 /
10003 / 30000 / 30003 events and forwards them to our relay, so a
long-time Damus user's bookmark history and follow sets show up the
moment they sign up.

[NIP-01]: https://github.com/nostr-protocol/nips/blob/master/01.md
