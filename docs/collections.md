# Collections

Deepmarks collections are explicit lists of bookmarks. They are not tags,
and collection membership is not inferred from bookmark tags.

A bookmark keeps its normal tags. A collection stores its own ordered URL
membership list, so one collection can span many tags and one tag can
appear across many unrelated collections.

## Event Model

Collections use single-author NIP-51 bookmark set events:

- `kind:30003`
- owner pubkey is the collection curator
- public collection `d` tag: `deepmarks-collection:<slug>`
- private collection `d` tag: `deepmarks-collection-private:<sha256(slug)>`
- public members are `r` URL tags on the public event
- private collection metadata and members are encrypted to self with
  NIP-44 in the event content

Public event shape:

```json
{
  "kind": 30003,
  "tags": [
    ["d", "deepmarks-collection:machine-learning"],
    ["title", "Machine Learning"],
    ["visibility", "public"],
    ["r", "https://example.com/paper", "Example Paper", "1781650000"]
  ],
  "content": ""
}
```

Private event content decrypts to:

```json
{
  "slug": "machine-learning",
  "title": "Machine Learning",
  "members": [
    {
      "url": "https://example.com/private-note",
      "title": "Private Note",
      "addedAt": 1781650000
    }
  ]
}
```

The `deepmarks-collection:` prefixes keep Deepmarks collections separate
from third-party NIP-51 bookmark lists. The normal NIP-51 importer skips
these events so collection members do not appear as loose imported
bookmarks.

## Slugs

Collection slugs are generated from the collection name by:

- trimming whitespace and leading `#`
- lowercasing
- replacing non-alphanumeric runs with `-`
- trimming leading/trailing dashes

Examples:

- `Machine Learning` -> `machine-learning`
- `AI/research` -> `ai-research`
- `#reading-list` -> `reading-list`

## Public And Private Collections

- A **public collection** publishes its title and member URLs in a public
  `kind:30003` event. It can be shared at
  `/u/<user>/<collection-slug>`.
- A **private collection** encrypts title and members to the owner. It is
  visible only inside `/app/collections`. Note the unencrypted *outer*
  event still carries `["visibility","private"]` and a
  `["member_count", N]` tag, so the number of items in a private
  collection is public even though the name and member URLs are not.

Public share pages render only public bookmark events by the same owner
whose URLs appear in the public collection event. A private bookmark in a
public collection is not exposed unless the bookmark itself is made
public.

## Routes

- `/app/collections` — signed-in collection index with public/private
  counts and links to owned collection views.
- `/app/collections/<collection-slug>` — signed-in collection view. This
  renders public and private bookmarks the owner can decrypt, supports
  scoped search, and shows the normal tag cloud derived from only the
  bookmarks inside that collection.
- `/u/<user>` — public profile. The profile has `bookmarks`, `posts`, and
  `collections` tabs. Visitors see public collections only; the owner can
  also navigate to private collection app views.
- `/u/<user>/<collection-slug>` — public share page for one public
  collection.

## Editing UX

Every owner-visible bookmark row includes a `collection` action. It can:

- add the bookmark URL to an existing collection
- create a new public or private collection and add the bookmark URL to it

This publishes a replacement collection event. It does not republish the
bookmark and does not add a tag.

When viewing `/app/collections/<collection-slug>`, the add-bookmark
control saves the bookmark normally, then adds the saved URL to that
collection. On native iOS and Android, the same flow opens
`/app/save?collection=<collection>&collectionVisibility=<public|private>&returnTo=...`
so the user returns to the collection after saving.

## Mobile

The native bottom tab bar includes `collections` by default. Users can
still customize the tab set from the More menu.

The row-level collection action is tap-open on mobile and renders as a
bottom sheet above the native tab bar. The input uses 16px text sizing to
avoid iOS zoom-on-focus behavior.

Native share sheets do not yet ask for a collection explicitly. Saving
from inside a collection uses the `/app/save?collection=...` route so
the app can attach the saved URL to the explicit collection event after
the bookmark is created.

## Search

The horizontal action bar search is scoped to the current view by
default:

- bookmarks searches the current bookmark view
- read later searches read-later bookmarks
- archives searches archives
- tag pages search that tag
- collection pages search that collection

Views that also offer an "include all my bookmarks" checkbox only expand
the search scope after the user enables it.
