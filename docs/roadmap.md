# Roadmap Notes

This file tracks scoped follow-up product work that has been accepted
conceptually but is not part of the currently shipped behavior.

## Batch Bookmark Actions

Batch actions should let users select many bookmarks and apply one
operation across the selection.

Initial actions:

- add/remove tags or collections
- mark read later / mark read
- enqueue archive
- make public / make private
- export selected bookmarks
- delete selected bookmarks

Design constraints:

- Selection must work on web and native mobile. On mobile, favor a
  long-press/select mode and a bottom action bar rather than dense
  checkbox chrome on every row by default.
- Batch privacy changes must preserve the current safety ordering:
  private -> public publishes public first, then removes private;
  public -> private writes private first, then requests public deletion.
- Batch delete must use the same two-stage confirmation language as
  single-row delete, with explicit wording that public relay copies may
  linger outside cooperative relays.
- Batch archive should be queue-oriented. It should not block the UI on
  worker completion.
- After imports, the import review screen should be able to hand a
  filtered subset directly into batch mode.

## Broken-Link Cleanup

Cleanup belongs in Settings because it is library maintenance, not a
normal browsing workflow.

Shipped client-side buckets:

- same canonical URL saved more than once
- archive missing for a bookmark that should be archived
- archive worker failed because the target is blocked, gone, or no
  longer capturable

Remaining backend-backed buckets:

- DNS/HTTP status probes with SSRF-safe networking
- redirect target capture
- import-time preflight checks so obviously broken links can be surfaced
  before the user spends time importing them

Bulk delete from cleanup must be gated behind explicit selection and a
confirmation step. For public bookmarks it publishes NIP-09 deletion
requests; for private bookmarks it publishes encrypted per-item
tombstones.
