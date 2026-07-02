# Deepmarks Android 2.0.3

This Android release aligns the mobile app with the latest Deepmarks
2.0.3 web bundle and relay-first archive behavior:

- Adds richer scholarly metadata fallback through DOI and Crossref when
  publisher pages block ordinary metadata scraping.
- Supports multi-file scholarly archives, so eligible article archives
  can expose both the captured HTML page and the full-text PDF.
- Keeps private archive file keys reconciled across all files in a
  multi-file archive.
- Uses the updated settings defaults: public bookmarks by default unless
  the user has chosen private, and read-later only when explicitly
  enabled.
- Benefits from longer-lived profile cache records for faster identity
  display in friend and contact surfaces.
- Includes the latest Android signer, NWC, QR import, friends feed, and
  archive fixes from the shared 2.0.x mobile release line.
