# Read Later

Deepmarks' "read later" feature is a tag — `toread` — not a separate
data type. We use pinboard's convention so import / export round-trip
cleanly with bookmark managers that already know it.

## Wire format

A bookmark is "saved for later reading" when its tag list contains
`toread`. The inner tag shape for both public (`kind:39701`) and
private (`kind:30003` chunked set entries) events is the same:

```
['t', 'toread']
```

Other Nostr clients (Damus, Primal, Amethyst) that surface tag-based
filters can read this directly. Pinboard exports / imports preserve
it. No new event kind, no new field.

## UI surfaces

- **Navigation entry** — on web, the `read later` tab at the top of
  `/app/bookmarks` filters to `toread`-tagged items. On iOS and
  Android, the same view is reached through the native bottom tab
  system: it appears in the More menu by default and can be added to
  the visible tab row through bottom-tab customization.
- **Visual indicator on rows** — `toread`-tagged rows get a
  light-orange tint (`--toread-tint`) and a `📖 read later` pill in
  the facts row of `BookmarkCard` / `LandingFeedRow`.
- **One-click toggle** — every owner row in `BookmarkCard` has a
  toggle button in the actions row. Click flips the `toread`
  tag in/out and republishes the bookmark through `/publish`. The
  toggle is optimistic: the local cache flips immediately, the
  server publish happens in the background, and a failed publish
  reverts.
- **Save form** — every save form (web, iOS share extension, Android
  share sheet, browser extension popup) has a "Read later" toggle that
  pre-toggles based on the `mark new bookmarks as read later by default`
  setting.

## Default behavior

The "mark new bookmarks as read later by default" setting is a
**single boolean represented by membership of `toread` in
`defaultTags`**. We didn't add a separate flag — `defaultTags` is
already a server-synced array, and `'toread'` either is or isn't in
it. The settings UI flips that membership when the user toggles the
checkbox.

Default ships as `defaultTags: ['toread']`. New users land with
read-later on, which matches the common "save now, decide later"
workflow.

## Toggle implementation

Files of interest:

- `frontend/src/lib/nostr/toggle-read-later.ts` — `toggleReadLater(bookmark, pubkey)`
  builds a new template with the flipped tag, calls
  `rememberOwnBookmark` to update the local cache synchronously, and
  fires `publishEvent` (or the chunked private-set path) in the
  background. Returns `{ bookmark, publish }` so callers can show a
  "syncing" spinner without blocking the UI on the relay round-trip.
- `frontend/src/lib/components/BookmarkCard.svelte` — the toggle
  button calls `toggleReadLater`, then awaits `result.publish` only
  to keep `togglingReadLater` flagged true for the spinner. The
  visible label (`✓ read` vs `📖 read later`) is driven by
  `bookmark.tags.includes('toread')`, which flips on the optimistic
  update.

## Cross-client sync

The toggle flows through the standard save / edit paths, so:

- The durable publish queue catches the publish if the initial
  `/publish` POST fails before the server accepts it.
- Other clients pick up the new tag set the next time they fetch
  (relay subscription on web, foreground refresh on native, popup
  open on extension).

No special read-later sync infrastructure.
