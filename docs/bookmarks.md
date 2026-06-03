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
['published_at', unixSeconds]      // user save time; stable sort key
['published_at_ms', unixMillis]    // optional same-second ordering key
['lightning', lud16OrLnurl]        // optional detected zap target
['blossom', sha256]                // archive blob hash
['wayback', snapshotUrl]           // optional fallback snapshot
['archive-tier', 'forever']        // lifetime archive marker
```

Public writes are signed on the user's device and POSTed to
`/publish`. The server writes the signed event to
`relay.deepmarks.org`, then fans out to the user's NIP-65 write relays.
The app also notifies `POST /bookmarks/public` so the Redis first-paint
cache and Meilisearch index catch up quickly.

`published_at` is the durable bookmark time and does not change on edit,
archive, import, or later relay fanout. Newer Deepmarks clients also add
`published_at_ms` when it falls inside the same unix second; readers use
it only as a tie-breaker so rapid share-sheet saves keep their real order
without changing the canonical Nostr seconds timestamp.

## Private bookmarks

Private saves are not sent as `kind:39701`. They live inside chunked
`kind:30003` NIP-51 sets named `deepmarks-private*`, encrypted to the
user's own pubkey with NIP-44 v2. The inner tag shape matches public
bookmarks, which lets the web app, mobile app, and extension render the
same UI after decryption.

Native mobile share sheets may publish a single encrypted private-item
event instead of rewriting the full chunked set:
`kind:30003`, `d=deepmarks-private-item:<sha256(url)>`, content =
NIP-44 encrypted JSON containing the same inner tag array. Readers merge
the latest private item events with the chunked set, preferring the
newer containing event for duplicate URLs.

Private bookmarks are searchable only on the user's device after the
signer decrypts the set. They are never included in public search or
`/api/v1`.

New private entries should carry the same `published_at` and optional
`published_at_ms` tags as public bookmarks. Legacy private entries that
lack those tags use a deterministic fallback derived from the enclosing
encrypted set's `created_at` and the entry's order inside that set. This
keeps normal windows, incognito windows, mobile apps, and fresh installs
in the same order instead of relying on browser-local cache timestamps.

## Personal Library

`/app/bookmarks` merges:

- public bookmarks from the API/relay/cache
- private bookmarks from local cache and decrypted NIP-51 sets
- optimistic saves/imports remembered locally immediately after publish

The personal **sort** options are intentionally just ordering:

- `newest`
- `⚡ sats`
- `oldest`
- `title a-z`
- `title z-a`

The app renders these as compact controls so they fit on phone widths:
newest/oldest use down/up arrow icons, zap sorting uses a lightning
icon, and title sorting uses A-Z/Z-A controls. The sort bar wraps if it
needs to; it should not require horizontal scrolling.

**Filtering** (what subset to show) is decoupled from sorting. On web it
lives in the section nav tabs above the sort row: `bookmarks` (all),
`posts`, `read later`, `archives`. On iOS and Android, the duplicated
section nav is hidden and the native bottom tab system owns mobile
navigation. `Posts` and `Read later` are available from the More menu by
default and can be added to the visible tab row; archived items are
opened from each bookmark row's archive controls. The underlying
mechanism is still a `?view=archived` or `?view=readlater` query param.

Zap sorting uses NIP-57 receipts for the row's actual Nostr target:
`kind:39701` bookmark events for normal bookmarks and the underlying
`kind:1` event for saved post rows. Targeted receipt queries include
common public Nostr relays, so zap totals are not limited to zaps sent
inside Deepmarks.

Bookmark list pages render 50 rows at a time with a `load more` control.
The full collection can still drive sidebar stats and tag clouds, but the
DOM stays small enough for accounts with thousands of bookmarks.

Completed archives render as a compact archive icon in the row's
actions row (which sits below the row's facts row — see "Row
structure" below). The same icon shape is used whether the archive is
public or private; the privacy chip up by the URL tells the user
which. Public icons open the Blossom snapshot; private icons decrypt
locally before opening (or fall back to the localStorage stash if the
chunked archive-keys set hasn't been published yet — see
[archives.md](archives.md)). Scholarly article archives can contain
both the rendered HTML page and a full-text PDF; those rows open a
small chooser from the archive icon. Media add-on archives also use the
archive icon, but it opens a play/download menu: web play decrypts and
renders inline, while mobile native play decrypts and launches the file
through the device media path. Pending/running archive intent
stays out of normal rows and is shown in the web archives/progress view
or the server archive status surfaces. The right-rail archived count is
the completed `/account/archives` count, not the number of bookmarks
that have an `archive-tier` intent tag.

## Row structure

A bookmark row has three parts, stacked top-to-bottom:

1. **Title line** — the page title plus a small `private`/`public`
   chip when the viewer is the owner. The chip is text-only (no
   lock/globe emoji) so the row's visual vocabulary stays narrow.
2. **Facts row** — tags, save count ("N others saved this"), and the
   "by username" credit. The credit is suppressed on the user's own
   bookmarks since they already know who saved it.
3. **Actions row** — separated from facts by a dashed rule. Holds
   archive open/download, zap, post-to-Nostr, edit, and read-later
   toggle. Follow/unfollow is **not** here — it lives on the
   curator's `/u/<npub>` profile page so feed rows aren't crowded
   with chrome the user isn't trying to act on.

## Read later

The `toread` tag (pinboard convention) marks a bookmark for later
reading. Rows with `toread` get a light-orange tint, a `📖 read later`
pill in the facts row, and a one-tap "✓ read" toggle in the actions
row. The `read later` navigation entry filters to the same set. New
saves include `toread` only when the user enables **mark new bookmarks
as read later by default** in settings. That toggle lives on top of the
same `defaultTags` field that already syncs across web, iOS, Android,
and the browser extension.

## Cross-client sync

Saves are durable. If the initial `/publish` POST fails before the
server accepts the signed event, the event template lands in a
per-pubkey localStorage queue (`deepmarks-pending-publish:<pubkey>`)
that drains on:

- app load (signer subscribe)
- foreground (`document.visibilitychange` on web, Capacitor
  `appStateChange` on native)
- a 90 s background timer while the app is open
- the signer becoming available after a passkey unlock

`drainPendingPublishes` signs and POSTs four templates in parallel,
dedupes replaceable events by `kind + d-tag`, and drops items after
30 attempts or 30 days so the queue can't grow forever. The full
documentation is in [durable-publish.md](durable-publish.md).

Reads use the same canonical relay set (`relay.deepmarks.org` + the
user's active list + the user's NIP-65 advertised relays) for private
bookmarks and the archive-keys set, so NDK's default NIP-65 outbox
routing can't skip the canonical Deepmarks store.

## Edit, Delete, And Visibility

Editing a public bookmark republishes the `kind:39701` replacement.
Editing a private bookmark rewrites the matching entry inside the
encrypted private set.

Deleting a public bookmark publishes a NIP-09 `kind:5` deletion request.
Deleting a private bookmark removes the entry from the encrypted set,
republishes the set, and publishes an encrypted private-item tombstone
for the URL so a standalone mobile share item cannot reappear later.

Switching visibility uses a two-step flow:

- private to public: publish public first, then remove the private entry
- public to private: write private first, then request public deletion

## Related Routes

- `/app/bookmarks` — signed-in user's bookmark library
- `/app/posts` — Nostr social posts or Nostr note URLs the user saved
- `/app/tags` — personal tag list/cloud
- `/app/tags/<tag>` — your bookmarks under one tag
- `/app/explore` — public/global bookmarks and global tags
- `/app/url/<encoded-url>` — all public saves of one URL
