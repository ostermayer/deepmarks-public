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

The search box also accepts simple natural date phrases and normalizes
them into the same date filters before searching. Examples:

- `show me my bookmarks from two years ago`
- `bitcoin from last year`
- `creatine in march 2024`
- `podcasts from the past 30 days`
- `links from today` / `links from yesterday`
- `creatine papers with pdfs` — `papers` asks for scholarly-looking
  sources and `pdfs` asks for direct or likely PDF-backed pages, such
  as PMC and arXiv article pages

Results render in 50-row batches with `load more`, so large personal
libraries can be searched without mounting thousands of rows at once.

Supported local modifiers:

- `#tag` or `tag:tag` — require a tag
- `site:example.com` — require a hostname
- `after:YYYY-MM-DD`
- `before:YYYY-MM-DD`
- `filetype:pdf` — require a direct PDF URL
- `has:pdf` — require a direct PDF URL or a scholarly page with an
  obvious PDF version

Private bookmarks never leave the browser for search.

## Global Search

The search page has a small `global search` toggle. When enabled,
`/app/search?q=<text>&global=1` tries
`GET /search/semantic/public` first and falls back to
`GET /search/public` when the semantic store is unavailable or still
empty.

Global search is public-only. Semantic search is backed by Qdrant when
configured; lexical fallback is backed by Meilisearch. Both index
`kind:39701` events seen by `relay.deepmarks.org` or submitted through
the public bookmark write-through API, and both exclude delisted events.

Global search supports the public query language:

- plain full text
- `#tag` / `tag:tag`
- `site:example.com`
- `@author` / `by:author`
- `after:` / `before:`
- `filetype:pdf`
- `has:pdf`
- `scholarly:yes`
- `zaps:>N`
- `saves:>N`

It uses the same natural date normalization as personal search. Natural
phrases are deterministic parser rules, not an LLM call: they turn
phrases like `from two years ago` or `last month` into `after:` /
`before:` filters and keep the remaining words as the full-text query.

When LLM augmentation is enabled, `/search/public` also searches additive
LLM fields (`llm_summary`, `llm_tags`, `llm_category`) stored in the
Meilisearch document. The original bookmark event and user-authored tags
are not modified.

## Semantic Search

`GET /search/semantic/public?q=<text>` is available when the LLM worker is
enabled and has embedded public bookmarks. It embeds the query with the
configured DeepInfra embedding model and searches Qdrant when configured;
Redis-stored bookmark embeddings remain a fallback path while Qdrant is
unavailable or empty. The endpoint also parses the same public query
modifiers as lexical search, so public tag, site, author, date,
PDF/scholarly, save, and zap filters can constrain the vector search.

Semantic search is public-only. Existing bookmarks are embedded by the
opt-in LLM backfill described in
[`llm-augmentation.md`](llm-augmentation.md); newly indexed public
bookmarks are queued by the normal indexer path.

## Freshness

Personal search should show a just-saved or just-imported bookmark
immediately because the import/save path seeds the local bookmark store.

Global search depends on:

1. relay publication
2. public bookmark write-through or indexer fanout
3. Meilisearch indexing

That makes it eventually consistent by design.
