# Deepmarks deploy

Three Linode boxes:

- **box-a** (VPC 10.0.0.2, **8 GB**) — public edge: caddy, strfry, blossom-server, api (HTTP API), the four background-worker containers (`worker-search-indexer`, `worker-relay-sync`, `worker-enrichment`, `worker-payments`), redis, meilisearch, qdrant, searxng. Resized 4→8 GB on 2026-06-25 for the worker split.
- **box-b** (VPC 10.0.0.3) — private worker: archive-worker (Playwright + SingleFile), Dedicated 4 GB with Docker `cpus: "1.5"` and `MAX_CONCURRENT_JOBS=1` by default
- **box-c** (VPC 10.0.0.4) — private signer: nsecBunker (holds operational nsecs, talks NIP-46 to api via strfry)

All three boxes share a Linode VPC (10.0.0.0/24). Box B reaches Redis + api on Box A via the VPC; Box C reaches strfry on Box A via the VPC. No nsec ever lives on Box A — api requests signatures from Box C over NIP-46.

Box B is sized for background archive throughput, not realtime capture.
Keep the CPU and concurrency caps in place unless you are deliberately
trading bandwidth-alert headroom for faster backlog drain.

Box B's media scratch directory is bind-mounted from Linode Block Storage:
`/mnt/deepmarks-archive-tmp/archive-worker` on the host appears as
`/var/tmp/deepmarks-archive` inside the archive-worker container. Keep
large media captures on that mount, not the 512 MB `/tmp` tmpfs.

## First-time setup on a fresh box

Everything needed to stand up a brand-new Box A or Box B is in `deploy/provision/`.

1. Create a Linode (Debian 13, Chicago `us-ord`). Copy `deploy/provision/stage1-harden.sh` to the box and run it **as root**:
   ```
   scp deploy/provision/stage1-harden.sh root@BOX_IP:/tmp/
   ssh root@BOX_IP 'bash /tmp/stage1-harden.sh a'     # Box A (public ports 80/443)
   # or 'bash /tmp/stage1-harden.sh b' for Box B (SSH-only, uses VPC).
   ```
   Then verify you can SSH as `dan@BOX_IP` before restarting sshd.

2. Run `stage2-docker.sh` as root to install Docker Engine + Compose.
   ```
   ssh dan@BOX_IP 'sudo bash /tmp/stage2-docker.sh'
   ```
   Log out + back in so `dan` picks up the `docker` group.

3. Run `stage3-clone.sh` as `dan` to generate the deploy key, add it to GitHub
   (it prints the public key), and clone the repo to `/opt/deepmarks-repo`.
   ```
   scp deploy/provision/stage3-clone.sh dan@BOX_IP:/tmp/
   ssh dan@BOX_IP 'bash /tmp/stage3-clone.sh'
   # prints the deploy-key to register; re-run after registering.
   ```

4. Copy the appropriate .env template and fill in secrets:
   ```
   ssh dan@BOX_IP 'cp /opt/deepmarks-repo/deploy/box-a/.env.example \
                       /opt/deepmarks-repo/deploy/box-a/.env && \
                    chmod 600 /opt/deepmarks-repo/deploy/box-a/.env && \
                    nano /opt/deepmarks-repo/deploy/box-a/.env'
   ```

5. First deploy:
   ```
   ssh dan@BOX_IP '/opt/deepmarks-repo/deploy/deploy.sh a'   # or b
   ```

## Subsequent deploys

From your laptop, use the one-command helper at repo root:

```
./deploy/push-deploy.sh                     # you've already committed; push + deploy all boxes
./deploy/push-deploy.sh -m "fix caddyfile"  # stage + commit everything, push, deploy
./deploy/push-deploy.sh -m "..." --only a   # Box A only
./deploy/push-deploy.sh --skip-remote       # push only (Cloudflare Pages rebuilds on its own)
```

Internally that does `git push`, then SSHes to each selected box as
`dan` and runs `/opt/deepmarks-repo/deploy/deploy.sh {a|b|c}`, which does
`git pull --ff-only && docker compose build && docker compose up -d`.

> ⚠️ **On Box A, deploy *targeted* services — not a bare `deploy.sh a`.**
> A no-service `deploy.sh a` runs a full `docker compose build`, which
> cold-recompiles **strfry from C++ source** (`make -j` × `g++ -O3`)
> alongside the node build. That OOM'd the box and took the API + sshd
> down on 2026-06-25. Name the services so strfry/caddy are never rebuilt:
>
> ```
> ssh dan@<box-a-public-ip> '/opt/deepmarks-repo/deploy/deploy.sh a \
>   api worker-search-indexer worker-relay-sync \
>   worker-enrichment worker-payments'
> ```
>
> For an API-only change, just `deploy.sh a api`. Only run a
> bare full build when strfry/caddy actually changed, and watch `free -m`.
> If the box wedges, **reboot from the Linode console** — `restart:
> unless-stopped` brings the previous containers back, and an unfinished
> build is discarded.
>
> The API runs `RUN_WORKERS=none` and serves HTTP only; the worker
> containers (`WORKER_GROUP=…`) own the background fleet. Set
> `RUN_WORKERS=all` + drop the worker services to fold everything back
> into one process (single-box / emergency fallback).

Cloudflare Pages (frontend) **always** auto-rebuilds on push — no remote step needed there.

## Backups and restore tests

Box A has automated backup scripts for the two non-derived data stores:

- Redis RDB snapshots: `deploy/box-a/backup-redis.sh`
- strfry event exports: `deploy/box-a/backup-strfry.sh`
- Object Storage safety smoke test: `deploy/box-a/object-storage-safety-check.sh`

Install the user-level systemd timers on Box A:

```bash
/opt/deepmarks-repo/deploy/box-a/install-backup-cron.sh
```

That also installs `deepmarks-restore-test.timer`, which downloads the
latest Redis + strfry backup manifests from Object Storage, checks sizes
and SHA-256 hashes, restores them into throwaway containers, and samples
Blossom archive blobs. It also installs
`deepmarks-object-storage-safety.timer`, which verifies the backup bucket
boundary and bucket-level protection settings. Full runbook:
[`docs/backup-restore.md`](../docs/backup-restore.md).

## Layout

```
deploy/
  deploy.sh              # one entry point, takes a|b|c
  box-a/
    compose.yml          # references ../../api as build context
    Caddyfile
    strfry/{Dockerfile, strfry.conf, deepmarks.js}
    .env.example
    .env                 # gitignored; real secrets, chmod 600
  box-b/
    compose.yml          # references ../../archive-worker as build context
    .env.example
    .env                 # gitignored
  box-c/
    compose.yml          # references ../../bunker as build context
    setup-system.sh      # one-time: creates bunker:bunker uid 900 + dirs
    .env.example
    .env                 # gitignored
```

`.env` is per-box. Secrets never live in the repo.

### First-time Box C setup

Box C needs host-level init before the first compose build because
nsecs live outside the container image in bind-mounted host
directories:

```bash
sudo bash /opt/deepmarks-repo/deploy/box-c/setup-system.sh
# Drop the nsecs at /opt/deepmarks-bunker/nsecs/{brand,personal}.nsec
# chmod 400, owned by bunker:bunker.
cp deploy/box-c/.env.example deploy/box-c/.env   # chmod 600, fill in BUNKER_CLIENT_PUBKEY
/opt/deepmarks-repo/deploy/deploy.sh c
```
