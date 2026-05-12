# Bookmarks

Deepmarks' core object is a URL bookmark owned by a Nostr pubkey.

## Public bookmarks

Public saves are signed client-side as `kind:39701` parameterized
replaceable events. The URL is the `d` tag, so saving the same URL again
replaces the user's older version rather than creating duplicates.

Canonical tags:

```ts
['d', url]
['title', title]
['description', description]
['t', tag]
['published_at', unixSeconds]      // optional source-page publish date
['lightning', lud16OrLnurl]        // optional detected zap target
['blossom', sha256]                // archive blob hash
['wayback', snapshotUrl]           // optional fallback snapshot
['archive-tier', 'forever']        // lifetime archive marker
```

Public writes go to the user's relays and write-through to
`POST /bookmarks/public` so the Deepmarks relay, Redis first-paint cache,
and Meilisearch index catch up quickly.

## Private bookmarks

Private saves are not sent as `kind:39701`. They live inside chunked
`kind:30003` NIP-51 sets named `deepmarks-private*`, encrypted to the
user's own pubkey with NIP-44 v2. The inner tag shape matches public
bookmarks, which lets the web app, mobile app, and extension render the
same UI after decryption.

Private bookmarks are searchable only on the user's device after the
signer decrypts the set. They are never included in public search or
`/api/v1`.

## Personal Library

`/app/bookmarks` merges:

- public bookmarks from the API/relay/cache
- private bookmarks from local cache and decrypted NIP-51 sets
- optimistic saves/imports remembered locally immediately after publish

The personal sort options are intentionally limited to:

- `newest`
- `oldest`
- `title a-z`
- `title z-a`
- `archived only`

Network popularity sorts such as most-saved and most-zapped belong on
global/public views where the rows have aggregate counts.

Bookmark list pages render 50 rows at a time with a `load more` control.
The full collection can still drive sidebar stats and tag clouds, but the
DOM stays small enough for accounts with thousands of bookmarks.

Completed archives render as a compact archive icon in the row metadata.
Public icons open the Blossom snapshot; private icons decrypt locally
before opening. Pending/running archive intent stays out of normal rows
and is shown in the archived-only progress panel instead. The right-rail
archived count is the completed `/account/archives` count, not the number
of bookmarks that have an `archive-tier` intent tag.

## Edit, Delete, And Visibility

Editing a public bookmark republishes the `kind:39701` replacement.
Editing a private bookmark rewrites the matching entry inside the
encrypted private set.

Deleting a public bookmark publishes a NIP-09 `kind:5` deletion request.
Deleting a private bookmark removes the entry from the encrypted set and
republishes the set.

Switching visibility uses a two-step flow:

- private to public: publish public first, then remove the private entry
- public to private: write private first, then request public deletion

## Related Routes

- `/app/bookmarks` — signed-in user's bookmark library
- `/app/posts` — Nostr social posts or Nostr note URLs the user saved
- `/app/tags` — network or personal tag list/cloud
- `/app/tags/<tag>` — bookmarks under one tag
- `/app/url/<encoded-url>` — all public saves of one URL
