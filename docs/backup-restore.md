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

Object Storage bucket retention should be enforced by bucket lifecycle
rules on the `redis/` and `strfry/` prefixes, not by the backup host.
The backup scripts only have write/read credentials and do not need broad
delete power.

## Scripts

All production scripts live in [`deploy/box-a`](../deploy/box-a):

- [`backup-redis.sh`](../deploy/box-a/backup-redis.sh) writes `redis/dump-<timestamp>.rdb`.
- [`backup-strfry.sh`](../deploy/box-a/backup-strfry.sh) writes `strfry/events-<timestamp>.jsonl.gz`.
- [`restore-test.sh`](../deploy/box-a/restore-test.sh) downloads the latest manifests and objects, verifies checksums, restores Redis and strfry into throwaway containers/directories, and samples archive blobs.
- [`install-backup-cron.sh`](../deploy/box-a/install-backup-cron.sh) installs user-level systemd timers.

`restore-test.sh` expects standard host tools already present on Box A:
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

Check status:

```bash
systemctl --user list-timers deepmarks-backup.timer deepmarks-backup-strfry.timer deepmarks-restore-test.timer
journalctl --user -u deepmarks-backup.service -u deepmarks-backup-strfry.service -u deepmarks-restore-test.service -n 200
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
BLOSSOM_PUBLIC_BASE=https://blossom.deepmarks.org
ARCHIVE_BLOB_SAMPLE_LIMIT=3
ARCHIVE_BLOB_MAX_BYTES=104857600
```

Set `ARCHIVE_BLOB_SAMPLE_LIMIT=0` to skip Blossom blob sampling if the
test should be purely data-store restore validation.

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
