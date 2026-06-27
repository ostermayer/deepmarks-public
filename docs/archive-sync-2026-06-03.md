# Archive Sync Incident - 2026-06-03

> **Historical snapshot (June 3, 2026 incident).** The "current deployment
> state" below is as-of that date. For current posture see
> [`reliability-2026-06.md`](reliability-2026-06.md) and the live coverage
> catalog [`../tests/README.md`](../tests/README.md).

Production note for the sync/archive-icon incident investigated on
June 3, 2026. This records the user-visible symptoms, root causes,
fixes, deploy state, and remaining operational limits.

## Current Deployment State

These commits were pushed to `main` and deployed to Boxes A/B/C:

| Commit | Purpose |
|---|---|
| `e843cae` | Keep archive icons visible even when private archive-key chunks are incomplete. Missing decrypt keys should affect open/decrypt handling, not erase the existence indicator. |
| `acb1b4a` | Make `/publish` relay fanout retries durable and make archive metadata + queue writes atomic. |
| `bc9fa5c` | Load `/account/archives` incrementally on the client and index archive records by safe URL variants plus YouTube video IDs. |
| `2695282` | Requeue stale public archive jobs from persisted job metadata when they are not queued, processing, active, completed, or failed. |
| `1872420` | Persist the archive-audit Redis scan cursor so bounded audit passes advance through the stale backlog instead of rescanning the same first slice. |

Verification run during the incident:

- `frontend`: `npm test -- my-archives`
- `frontend`: `npm run check`
- `api`: full test suite after queue/fanout changes
- `archive-worker`: `npm test -- worker`
- `archive-worker`: `npm run build`
- `git diff --check`
- `curl -fsS https://api.deepmarks.org/health`
- `./deploy/push-deploy.sh`

Cloudflare Pages picks up the web frontend from GitHub `main`. Native
iOS/Android shells and browser extensions bundle web/client code, so
installed apps/extensions need new builds/submissions to get the
client-side archive-icon fix.

## Box Roles

| Box | Role | Why it matters for this incident |
|---|---|---|
| Box A | API, Caddy, strfry relay, Redis, Meilisearch, Blossom edge, backup timers | Owns `/publish`, `/account/archives`, `/account/archive-queue`, Redis archive metadata, object-storage credentials, and health endpoints. |
| Box B | Archive worker | Pulls `dm:archive:queue`, renders pages with Playwright/SingleFile, uploads to Blossom/S3, and calls Box A `/archive/callback`. |
| Box C | NIP-46 bunker | Holds operational signer nsecs. Not involved in archive rendering, except for normal signed operational events. |

Box A currently has an approximately 80 GB ext4 disk plus 512 MB swap.
Archive blobs must not live on that disk. Blossom is configured to use
the `deepmarks` Linode Object Storage bucket, and local Blossom data
should only contain SQLite/config/tmp state. A growing `/app/data/blobs`
directory means the S3 backend is not active and the box can fill again.

## Bookmark Sync Vs Archive Sync

Bookmark sync and archive-icon sync use different sources of truth:

- Public bookmarks are signed Nostr events. Clients submit to
  `POST /publish`; api persists to `relay.deepmarks.org` and
  fans out to the user's NIP-65 write relays. Pulling from the relay is
  the right source for bookmark rows.
- Private bookmarks are encrypted NIP-51 `kind:30003` sets. Relays carry
  ciphertext; clients decrypt and merge locally.
- Archive icons are not inferred from bookmark events alone. A bookmark
  can express archive intent via tags, but the icon means a completed
  archive record exists in `dm:archives:<pubkey>` and is returned by
  `/account/archives`.

Users should not see raw sync errors for transient relay/API failures.
Clients should keep local bookmarks visible, retry publish/sync in the
background, and only surface actionable account/auth states. Local cache
is a continuity layer, not the long-term source of truth.

## Screenshot Findings

The affected pubkey was:

```text
npub1gc64tw6tp7q06ymkltnz374l4al9uvwdyaqasz4y6gjujf4u9plqz2uyek
```

Hex pubkey:

```text
463555bb4b0f80fd1376fae628fabfaf7e5e31cd2741d80aa4d225c926bc287e
```

The missing archive icons split into two categories.

### Completed Archives Hidden By Client Loading

These rows had completed archive records in `dm:archives:<pubkey>` but
could be hidden on iOS/mobile because archive metadata was loaded as one
large all-or-nothing set and URL lookup was too exact:

| Bookmark | Production finding |
|---|---|
| `https://losslesscut.app/` | Completed public archive existed. It was in the first `/account/archives` page. |
| `https://m.youtube.com/watch?v=SVdTF4_QrTM&t=21s&pp=2AEVkAIB&ra=m` | Completed public archive existed. Client now also indexes YouTube webpage archives by `yt:<videoId>`. |
| `https://all3dp.com/2/temp-tower-cura-tutorial/` | Completed public archive existed. Trailing-slash URL variants now map to the same record. |
| `https://fips.network/` | Completed archive existed and already showed once cache recovered. |
| `https://unstack.io/halt-and-catch-fire` | Private archive existed and showed once incomplete private-key chunks stopped hiding records. |

Production archive count for the account was roughly 9,195 records. The
full `/account/archives` payload was about 5.96 MB; the first 1,000 rows
were about 776 KB. On mobile, one late page/cache/storage failure could
leave the app using stale archive metadata, so the newest rows stayed
missing even though the records existed.

Fix in `bc9fa5c`:

- page `/account/archives` with `limit=1000`
- merge each page into the Svelte store immediately
- keep the last full cache, but do not require a full successful load
  before showing newly fetched icons
- index archive records by exact URL, normalized URL, trailing-slash
  variants, hash-stripped URL, and YouTube video key when derivable

### No Completed Archive Exists

The OUP ebolavirus row did not have a completed archive record:

```text
https://academic.oup.com/bioscience/advance-article/doi/10.1093/biosci/biaf050/8116758
```

Production Redis had several `dm:archive-job:*` metadata rows for that
URL. The latest job audit showed:

- `taken`
- `render-start`
- `render-failed-before-wayback`
- `wayback-miss-after-render-failure`
- `attempt-failed`

Manual requeue after the worker recovery patch ran immediately and wrote
a terminal failed record:

```text
status: failed
error: page returned HTTP 403
errorCategory: permanent
```

Wayback returned no available snapshot for the URL during the incident.
That row will not show an archive icon until one of these is true:

- the publisher stops returning HTTP 403 to the worker
- Wayback gets a usable snapshot and the worker can rescue from it
- the user captures the current browser view through the extension's
  private browser-capture fallback
- a future capture path uses a user-provided authenticated/current page
  context safely

This is not a bookmark sync failure. It is an archive capture failure.

## Worker Recovery Changes

The archive worker already used crash-safe queue handoff:

```text
dm:archive:queue -> BLMOVE -> dm:archive:processing:<workerId>
```

On startup, `recoverOrphans()` moves jobs left in processing lists back
to the main queue.

The incident exposed a separate stale-job gap:

- some old public jobs had `dm:archive-job:*` metadata but no queue item,
  no processing item, no active heartbeat, no completed marker, and no
  durable failed `dm:archive:done:*` record
- the audit loop was bounded to 1,000 job metadata rows per pass
- every pass started at Redis scan cursor `0`, so with a larger history
  it could repeatedly inspect the same slice and never reach older stale
  rows

Fixes:

- stale public `webpage` and `file` jobs can be reconstructed from
  persisted metadata and requeued
- requeue claims live under `dm:archive-audit:requeue:<jobId>` with a
  short TTL to avoid duplicate repair storms
- private archives and media jobs are not automatically replayed from
  metadata because private/media encryption keys are intentionally not
  retained in metadata after queueing
- the audit scan cursor is stored at `dm:archive-audit:cursor` and
  cleared only after a full scan completes
- `dm:archive-audit:last` now includes `requeued` and `requeueDeferred`
  counters

## Object Storage Buckets

Observed bucket inventory during this incident:

| Bucket | Endpoint | Purpose | Notes |
|---|---|---|---|
| `deepmarks` | `deepmarks.us-southeast-1.linodeobjects.com` | Primary Blossom archive blobs and thumbnails | User-delete bucket. Do not enable Object Lock. Be cautious with versioning because normal deletes keep old versions/delete markers. |
| `deepmarks-backups` | `deepmarks-backups.us-southeast-1.linodeobjects.com` | Redis and strfry backup manifests/objects | Dedicated backup bucket. Versioning and lifecycle policy should be enabled here. |
| `deepmarks-favicons` | `deepmarks-favicons.us-southeast-1.linodeobjects.com` | Public favicon cache | Rebuildable. Versioning not needed. |
| `ciphertext` | `ciphertext.us-southeast-1.linodeobjects.com` | Passkey-encrypted nsec recovery blobs | Very small. Versioning disabled is a warning, not an immediate production failure. If enabled, keep noncurrent retention short, currently 30 days. |

Use:

```bash
cd /opt/deepmarks-repo/deploy/box-a
set -a
. ~/.config/deepmarks-backup.env
set +a
./configure-backup-bucket-policy.sh
./object-storage-safety-check.sh
```

For ciphertext versioning:

```bash
cd /opt/deepmarks-repo/deploy/box-a
set -a
. ./.env
set +a
CIPHERTEXT_NONCURRENT_RETENTION_DAYS=30 ./configure-ciphertext-bucket-policy.sh
```

The backup bucket should be separate from `deepmarks` because backup
retention controls and Object Lock conflict with user-requested archive
deletion semantics.

## Native Apps And Extensions

The server-side worker fixes apply after deployment. The client-side
archive-icon loading fix only reaches installed native apps/extensions
after those packages are rebuilt and submitted.

| Surface | Needs new submission for `bc9fa5c`? | Notes |
|---|---|---|
| Web | No manual app-store submission | Cloudflare Pages deploys from `main`. |
| iOS | Yes | Run the frontend build and `npx cap sync ios` before Xcode clean build/archive. A clean Xcode build alone does not refresh bundled web assets if Capacitor was not synced. |
| Android | Yes | Run frontend build and `npx cap sync android`, then build the release AAB/APK. |
| Zapstore | Yes for installed Android users | Publish the new signed APK after Android testing. |
| Browser extensions | Yes | Bump extension version, package Chrome/Firefox/Safari zips, and resubmit/update distribution. |

## Runbook Checks

Archive icon missing on a bookmark:

1. Confirm the bookmark event exists on `relay.deepmarks.org`.
2. Check `/account/archives` for a completed record matching the URL or
   a safe URL variant.
3. Check `dm:archives:<pubkey>` in Redis for the exact account record.
4. Check `dm:archive-job:*` metadata for the URL.
5. Check `dm:archive:queue`, `dm:archive:processing:*`, and
   `dm:archive:active:*` for a live job.
6. Check `dm:archive:done:<jobId>` and
   `dm:archive:audit:<jobId>` for terminal status or capture error.
7. If the source returns HTTP 403 and Wayback misses, treat it as a
   capture failure, not a sync failure.

Useful Redis keys:

```text
dm:archives:<pubkey>
dm:archive:queue
dm:archive:processing:*
dm:archive:active:*
dm:archive-job:<jobId>
dm:archive:done:<jobId>
dm:archive:audit:<jobId>
dm:archive-audit:last
dm:archive-audit:cursor
```

Post-deploy smoke:

```bash
curl -fsS https://api.deepmarks.org/health
ssh dan@<box-a-public-ip> 'cd /opt/deepmarks-repo && git rev-parse --short HEAD'
ssh dan@<box-b-public-ip> 'cd /opt/deepmarks-repo && git rev-parse --short HEAD'
ssh dan@<box-c-public-ip> 'cd /opt/deepmarks-repo && git rev-parse --short HEAD'
```

## Follow-Up Coverage

Tests added in this incident covered:

- archive records remain visible with missing private keys
- URL variant lookup for root and trailing-slash archive URLs
- YouTube webpage archives resolve through video ID lookup
- stale public archive jobs are requeued from metadata

Recommended next coverage:

- route-level tests for `/account/archives` and `/account/archive-queue`
- queue-level tests for `archive-worker/src/queue.ts`
- browser/mobile E2E smoke that saves a bookmark, observes the local row,
  waits for `/account/archives`, and asserts the archive icon appears
  after a refresh
- object-storage safety smoke as a required production timer, not an
  optional manual check
