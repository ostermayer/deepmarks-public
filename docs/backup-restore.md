# Backup And Restore Testing

Deepmarks treats backups as incomplete until a restore test has proven
they can be read back into a clean environment. Box A owns this because
it holds the primary runtime state: strfry, Redis, Meilisearch, and the
Blossom edge.

## What Is Backed Up

| Store | Backup | Why |
|---|---|---|
| strfry | `strfry export` JSONL, gzipped, uploaded to Object Storage | Canonical Nostr event history. This is the source of truth for public bookmarks, private set chunks, deletions, profiles, contacts, relay lists, zaps, and bunker messages. |
| Redis | RDB snapshot from `BGSAVE`, uploaded to Object Storage | Queue state, account settings, archive records, payment/lifetime state, cache material, relay allowlist (`dm:registered:pubkeys`), watched-contact frontier, and dashboard counters. Redis also has AOF enabled for local crash durability. |
| Blossom archive blobs | Stored in Linode Object Storage under content-addressed SHA-256 hashes | Private archive ciphertext and public archive blobs. The restore test samples blobs by downloading and checking `sha256(bytes) == blobHash`. |
| Meilisearch | Not separately backed up | Derived from strfry + Redis. Rebuild from canonical events/cache if lost. |

Backups should live in a dedicated Object Storage bucket (`BACKUP_S3_BUCKET`),
separate from the Blossom archive bucket (`S3_BUCKET`). Bucket versioning
and Object Lock are bucket-level controls; applying them to the archive
blob bucket would also retain old versions of user archive blobs after a
normal delete. The backup bucket is the place to enable versioning,
retention, and lifecycle rules.

## Scripts

All production scripts live in [`deploy/box-a`](../deploy/box-a):

- [`backup-redis.sh`](../deploy/box-a/backup-redis.sh) writes `redis/dump-<timestamp>.rdb`.
- [`backup-strfry.sh`](../deploy/box-a/backup-strfry.sh) writes `strfry/events-<timestamp>.jsonl.gz`.
- [`restore-test.sh`](../deploy/box-a/restore-test.sh) downloads the latest manifests and objects, verifies checksums, restores Redis and strfry into throwaway containers/directories, and samples archive blobs.
- [`object-storage-safety-check.sh`](../deploy/box-a/object-storage-safety-check.sh) verifies that backup manifests are readable, the backup bucket is separate from the archive bucket, and the backup bucket has versioning/lifecycle enabled.
- [`configure-backup-bucket-policy.sh`](../deploy/box-a/configure-backup-bucket-policy.sh) enables versioning and retention lifecycle on the dedicated backup bucket.
- [`configure-ciphertext-bucket-policy.sh`](../deploy/box-a/configure-ciphertext-bucket-policy.sh) optionally enables ciphertext bucket versioning with short noncurrent-version retention.
- [`install-backup-cron.sh`](../deploy/box-a/install-backup-cron.sh) installs user-level systemd timers.

`restore-test.sh` and the safety check expect standard host tools already present on Box A:
Docker, `curl`, `gzip`, `openssl`, and `python3`.

Every successful backup uploads two manifests:

- immutable history: `redis/manifests/<timestamp>.json` or `strfry/manifests/<timestamp>.json`
- latest pointer: `latest/redis.json` or `latest/strfry.json`

The latest manifests include `objectKey`, `sizeBytes`, `sha256`, and
for strfry, `eventCount`. The restore test refuses to run against a
missing or checksum-mismatched object.

## Automated Schedule

Run this once on Box A as the `dan` user:

```bash
/opt/deepmarks-repo/deploy/box-a/install-backup-cron.sh
```

The installer enables `loginctl` lingering for `dan` before enabling the
user timers. That matters because these jobs must keep running after the
SSH session closes. If passwordless sudo is unavailable, the installer
fails and prints the exact `sudo loginctl enable-linger dan` command to
run.

It creates:

| Timer | Time | Job |
|---|---:|---|
| `deepmarks-backup.timer` | 03:15 UTC daily | Redis RDB snapshot |
| `deepmarks-backup-strfry.timer` | 03:35 UTC daily | strfry export |
| `deepmarks-restore-test.timer` | 04:20 UTC daily | non-destructive restore test |
| `deepmarks-object-storage-safety.timer` | 04:55 UTC daily | Object Storage safety smoke test |

Check status:

```bash
systemctl --user list-timers deepmarks-backup.timer deepmarks-backup-strfry.timer deepmarks-restore-test.timer deepmarks-object-storage-safety.timer
journalctl --user -u deepmarks-backup.service -u deepmarks-backup-strfry.service -u deepmarks-restore-test.service -u deepmarks-object-storage-safety.service -n 200
```

The env file is:

```bash
~/.config/deepmarks-backup.env
```

Required:

```bash
LINODE_ACCESS_KEY=
LINODE_SECRET_KEY=
REDIS_PASSWORD=
S3_ENDPOINT=https://us-southeast-1.linodeobjects.com
S3_BUCKET=deepmarks
BACKUP_S3_BUCKET=deepmarks-backups
BACKUP_TMP_PARENT=/var/tmp
RESTORE_TEST_TMP_PARENT=/var/tmp
OBJECT_STORAGE_TMP_PARENT=/var/tmp
REDIS_BGSAVE_TIMEOUT_SECONDS=900
BLOSSOM_PUBLIC_BASE=https://blossom.deepmarks.org
ARCHIVE_BLOB_SAMPLE_LIMIT=3
ARCHIVE_BLOB_MAX_BYTES=104857600
REQUIRE_DEDICATED_BACKUP_BUCKET=1
REQUIRE_BACKUP_BUCKET_VERSIONING=1
REQUIRE_BACKUP_BUCKET_LIFECYCLE=1
```

Set `ARCHIVE_BLOB_SAMPLE_LIMIT=0` to skip Blossom blob sampling if the
test should be purely data-store restore validation.

## Object Storage Controls

Recommended bucket split:

| Bucket | Contents | Versioning / retention |
|---|---|---|
| `deepmarks-backups` | `redis/`, `strfry/`, `latest/` backup objects | Enable bucket versioning. Consider Object Lock governance/compliance only here, not on user-delete buckets. Add lifecycle rules for backup retention and stale multipart upload cleanup. |
| `deepmarks` | Blossom archive blobs | Do not enable Object Lock. Be cautious with bucket versioning because `DELETE` creates delete markers and keeps older object versions. |
| `ciphertext` | Passkey-encrypted nsec blobs | Versioning is a product/privacy tradeoff: it protects against accidental overwrite/delete, but retains old encrypted ciphertext after user deletion until lifecycle removes noncurrent versions. If enabled, keep noncurrent retention short, currently 30 days. |
| `deepmarks-favicons` | Rebuildable favicon cache | Versioning not needed. |

Observed production bucket inventory on June 3, 2026:

| Bucket | Approx. size / objects | Used for |
|---|---:|---|
| `deepmarks-backups` | operator-created backup bucket | Redis RDB and strfry JSONL backup objects plus `latest/` manifests. This is the bucket that should have versioning and lifecycle retention. |
| `deepmarks` | 3.23 GB / 44 objects | Primary Blossom archive blobs and thumbnails. User archive deletes target this bucket, so do not apply Object Lock here. |
| `deepmarks-favicons` | 11.5 MB / 1180 objects | Rebuildable public favicon cache. |
| `ciphertext` | 368 bytes / 4 objects | Passkey-encrypted nsec recovery ciphertext. Disabled versioning is a warning; if enabled, keep noncurrent retention short. |

Those counts are only a dated inventory snapshot. The bucket roles are
the important operational boundary.

Use the repo scripts on Box A:

```bash
set -a
. ~/.config/deepmarks-backup.env
set +a
/opt/deepmarks-repo/deploy/box-a/configure-backup-bucket-policy.sh
```

For the ciphertext bucket, source `deploy/box-a/.env` because those
credentials are the payment-proxy bucket credentials:

```bash
cd /opt/deepmarks-repo/deploy/box-a
set -a
. ./.env
set +a
CIPHERTEXT_NONCURRENT_RETENTION_DAYS=30 ./configure-ciphertext-bucket-policy.sh
```

Equivalent AWS-compatible tooling against the Linode endpoint:

```bash
aws s3api put-bucket-versioning \
  --endpoint-url https://us-southeast-1.linodeobjects.com \
  --bucket deepmarks-backups \
  --versioning-configuration Status=Enabled

aws s3api get-bucket-versioning \
  --endpoint-url https://us-southeast-1.linodeobjects.com \
  --bucket deepmarks-backups
```

Lifecycle should include retention for immutable backup objects and
cleanup for failed multipart uploads. Keep credentials used by the
backup jobs limited to read/write on the backup bucket; do not give the
nightly backup path broad delete permissions.

## What The Restore Test Proves

`restore-test.sh` is intentionally non-destructive:

1. Downloads `latest/redis.json`, then the referenced RDB object.
2. Verifies RDB size and SHA-256 against the manifest.
3. Runs `redis-check-rdb`.
4. Starts a throwaway `redis:7-alpine` container from that RDB and checks
   that it loads a non-empty keyspace.
5. Downloads `latest/strfry.json`, then the referenced gzipped export.
6. Verifies size, SHA-256, gzip integrity, and basic Nostr event JSON shape.
7. Imports the export into a throwaway `box-a-strfry:latest` database.
8. Exports the throwaway database again and checks the event count matches.
9. Samples archive blob hashes from the restored Redis archive records and
   verifies the fetched bytes hash to the recorded blob hash.
10. Runs a separate Object Storage safety smoke test that catches stale or
    missing manifests, missing bucket versioning/lifecycle, and accidental
    reuse of the archive bucket for backup retention controls.

This catches:

- bad Object Storage credentials
- missing latest manifests
- truncated uploads
- Redis RDB corruption
- strfry export corruption
- strfry import incompatibility after an image/config change
- archive records pointing to missing or hash-mismatched Blossom blobs

## Real Disaster Restore

For an actual Box A rebuild:

1. Provision Box A using [`deploy/README.md`](../deploy/README.md).
2. Pull the repo and fill `deploy/box-a/.env`.
3. Download the desired `latest/redis.json` / `latest/strfry.json` manifests
   or an older immutable manifest.
4. Download and checksum the referenced objects.
5. Restore Redis by placing `dump.rdb` into the `redis-data` Docker volume
   before starting Redis, with AOF disabled for the initial import if needed.
6. Restore strfry by importing the JSONL export into an empty `strfry-db`
   volume using the same image/config as production.
7. Start services, then run `restore-test.sh` again against the backup bucket
   and admin relay/cache checks from [`admin.md`](admin.md).
8. Rebuild derived Meilisearch/search state from strfry/cache if needed.

Do not point restore tests at production volumes. The automated test uses
temporary directories and throwaway container names specifically to avoid
touching live data.

## Live replication (Box B replica)

Box A's `strfry-stream` sidecar (which runs `strfry router` with `deploy/box-a/strfry/strfry-router.config` — the `strfry stream` CLI is deprecated upstream; the compose service keeps the old name) pushes every newly-stored event to a
VPC-only strfry replica on Box B (`10.0.0.3:7777`) within seconds — the
recovery point for a Box A disk loss is no longer the last nightly
export.

**Prerequisite (one-time):** the Linode Cloud Firewall on Box B must
allow TCP 7777 from 10.0.0.2 (Box A). The host ufw rule is already in
place. Until that rule exists the sidecar stays OFF (it's behind the
`replication` compose profile); enable it afterwards with
`cd /opt/deepmarks-repo/deploy/box-a && docker compose --profile replication up -d strfry-stream`.

**PID-namespace warning:** the sidecar MUST share the relay container's
PID namespace (`pid: "service:strfry"` in compose). LMDB tracks readers
by pid; a separate namespace collides with the relay's pids and crashes
it ("mdb_txn_begin: Resource temporarily unavailable" — 2026-06-09
incident).

- Seed (first boot, or after a replica DB reset):
  `ssh <box-a> 'cd /opt/deepmarks-repo/deploy/box-a && docker compose exec -T strfry strfry export' | ssh <box-b> 'cd /opt/deepmarks-repo/deploy/box-b && docker compose exec -T strfry-replica strfry import'`
- Reconcile a gap (replica downtime):
  `cd /opt/deepmarks-repo/deploy/box-a && docker compose --profile replication run --rm strfry-stream strfry sync ws://10.0.0.3:7777 --dir up`
- Verify: event counts on both sides
  (`strfry scan --count '{}'`) should converge within seconds of a write.
- Restore from replica: export from Box B, import on the rebuilt Box A —
  same procedure as the nightly-backup restore above, different source.
