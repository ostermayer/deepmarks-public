# Deepmarks Android 2.0.6

This Android release fixes archive icon reliability and archive recovery:

- Completed archive records load incrementally, so large archive
  libraries no longer wait on one all-or-nothing `/account/archives`
  response before bookmark rows show archive icons.
- Archive lookups now tolerate safe URL variants, including trailing
  slash differences and YouTube mobile/desktop watch URL variants.
- Archive records stay visible even when private archive-key chunks are
  temporarily incomplete; missing keys affect open/decrypt handling, not
  the archive existence indicator.
- The server-side archive worker now requeues stale public archive jobs
  from persisted metadata and advances its audit scan through the whole
  stale backlog over bounded passes.
- Bookmark publish retries and archive enqueue writes are more durable
  across mobile, desktop, and extension saves.
