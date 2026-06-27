# Import And Export

Deepmarks import/export runs in the browser. The server does not receive
plaintext private bookmark files.

## Supported Import Formats

- Netscape HTML
- Pinboard JSON
- Deepmarks CSV
- Pocket CSV
- Instapaper CSV
- Raindrop CSV

After parsing, the import page lets the user review bookmarks in pages
of 10, 25, 50, or 100 rows. Title, description, and tags are editable
before publish, and individual rows can be skipped. The primary publish
action lives above the review table so large imports do not require
scrolling past hundreds of rows before starting.

## Publishing Imports

Imports can be private or public.

Private imports:

1. Normalize URLs, titles, descriptions, and tags.
2. Merge rows into the user's existing encrypted `kind:30003` private
   bookmark set.
3. Split the set into multiple replaceable chunks when the NIP-44
   plaintext size would be too large.
4. Stamp each chunk with one version and expected chunk count.
5. Publish all chunks.

Readers only accept a complete private-set generation. If a browser
extension disconnects or a relay write fails partway through a large
import, Deepmarks does not mix new chunks with old chunks. The import
screen keeps the parsed rows in memory and offers a retry; retrying is
safe because bookmark entries are replaced by URL.

When the Deepmarks browser extension is unlocked, the web app uses its
first-party signer channel for private import encryption/signing. That
avoids a generic signer prompt loop while keeping the broad NIP-07
approval path unchanged for other websites.

Public imports:

1. Build one `kind:39701` event per bookmark.
2. Publish with bounded concurrency.
3. Write-through public events to `POST /bookmarks/public`.

## Progress UI

The progress bar counts real work units:

- one unit per bookmark prepared
- one unit per bookmark entry encrypted into the private set
- plus one unit per encrypted private-set event that must be published

This prevents private imports from showing 100% before the final NIP-51
set is actually accepted by relays.

After a successful import, the page seeds `ownBookmarks` with the
imported rows before navigating to `/app/bookmarks`, so the user should
see the imported bookmarks immediately instead of waiting for relays or
the public API cache.

For lifetime accounts with archive-by-default enabled, imports also queue
archives after the bookmark events are saved. Immediate archive enqueue
failures are stored in the local archive queue state, so `/app/settings`
-> cleanup can later surface imported URLs whose archive jobs failed.
Imported URLs that are merely missing archive records are queued again
instead of being shown as delete candidates.

## Export

Exports can also include bookmarks **imported from other Nostr
clients' NIP-51 lists** — including bookmarked posts, exported as their
social URL — via the "include imported" checkbox on /app/export.

`/app/export` can download every format Deepmarks imports:

- public bookmarks as signed `kind:39701` JSONL
- private bookmarks decrypted from the user's NIP-51 set
- Netscape HTML
- Pinboard JSON
- Deepmarks CSV
- Pocket CSV
- Instapaper CSV
- Raindrop CSV

Private export requires an unlocked signer because the browser must
decrypt the user's private set locally. Export fails closed if a private
chunk cannot be decrypted or parsed, rather than producing a partial
backup that looks complete.

Exported CSV-family formats preserve enough fields for round-trip import
tests to verify URL, title, description, tags, visibility, and archive
intent rather than silently dropping Deepmarks-specific metadata.

## Recovery-Key Backup Text

Identity recovery-key backups are separate from bookmark export. Signup,
web settings, and extension settings can download a plain `.txt` file
containing:

- the public `npub` when known
- the private `nsec`
- a monospace ASCII QR code encoding the same `nsec`

The QR block keeps the backup file text-only while letting the mobile
app scan the key into iOS Keychain or Android Keystore. The server never
receives this file or the plaintext `nsec`.
