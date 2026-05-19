# Search

Search defaults to the signed-in user's own bookmarks. This is deliberate:
most users expect the header search box to find something they saved, not
the whole public network.

## Personal Search

`/app/search?q=<text>` searches the shared `ownBookmarks` store in the
browser. That store includes:

- public bookmarks loaded from Deepmarks cache/API and relays
- private bookmarks decrypted from the user's NIP-51 sets
- freshly imported or saved bookmarks remembered locally immediately

Personal search matches title, description, URL, and tags. It is
case-insensitive and requires every plain word in the query to match
somewhere on the bookmark.

Results render in 50-row batches with `load more`, so large personal
libraries can be searched without mounting thousands of rows at once.

Supported local modifiers:

- `#tag` or `tag:tag` — require a tag
- `site:example.com` — require a hostname
- `after:YYYY-MM-DD`
- `before:YYYY-MM-DD`

Private bookmarks never leave the browser for search.

## Global Search

The search page has a small `global search` toggle. When enabled,
`/app/search?q=<text>&global=1` queries `GET /search/public` on
`payment-proxy`.

Global search is public-only. It is backed by Meilisearch and indexes
`kind:39701` events seen by `relay.deepmarks.org` or submitted through
the public bookmark write-through API.

Global search supports the public query language:

- plain full text
- `#tag` / `tag:tag`
- `site:example.com`
- `@author` / `by:author`
- `after:` / `before:`
- `zaps:>N`
- `saves:>N`

## Freshness

Personal search should show a just-saved or just-imported bookmark
immediately because the import/save path seeds the local bookmark store.

Global search depends on:

1. relay publication
2. public bookmark write-through or indexer fanout
3. Meilisearch indexing

That makes it eventually consistent by design.
