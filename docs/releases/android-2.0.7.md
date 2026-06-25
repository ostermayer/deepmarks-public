# Deepmarks Android 2.0.7

This release hardens private archive recovery across mobile, web, and
browser-extension saves:

- Private archive keys are synced as soon as the archive job is accepted,
  under a provisional `job:<jobId>` key, before final blob-hash
  reconciliation completes.
- Private archive opening now checks final blob-hash keys, then
  provisional job keys, then the local pending-key stash.
- Existing private archives with missing keys stay visible and can queue
  bounded replacement archives with fresh client-generated keys.
- Missing-key repair runs even when archive-all is disabled, so private
  archive recovery is independent from automatic archiving preferences.
- Browser extension archive saves use the same private-key sync path as
  the mobile app.
