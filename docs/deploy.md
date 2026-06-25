# deploy operator runbook

Day-to-day deploy reference and the small list of gotchas that have
bitten us. If a deploy is acting weird, check the **Gotchas** section
first — every entry there is a real incident with a real one-line fix.

---

## What runs where

| Service                 | Box | Container                  | Public hostname                    |
|-------------------------|-----|----------------------------|------------------------------------|
| Frontend (SvelteKit)    | —   | Cloudflare Pages           | `https://deepmarks.org`            |
| Caddy (TLS + reverse)   | A   | `box-a-caddy-1`            | (terminates 80/443 for the rest)   |
| api (Fastify) | A   | `box-a-api-1`    | `https://api.deepmarks.org`        |
| strfry (Nostr relay)    | A   | `box-a-strfry-1`           | `wss://relay.deepmarks.org`        |
| Blossom server          | A   | `box-a-blossom-server-1`   | `https://blossom.deepmarks.org`    |
| Redis                   | A   | `box-a-redis-1`            | (VPC-only, `10.0.0.2:6379`)        |
| Meilisearch             | A   | `box-a-meilisearch-1`      | (docker-network only, no external) |
| archive-worker          | B   | `box-b-archive-worker-1`   | (no inbound; pulls from Redis, CPU-capped) |
| nsecBunker (NIP-46)     | C   | `box-c-bunker-1`           | (VPC-only, `10.0.0.4:4100`)        |

In this private repo, the production SSH targets are listed in
[`deploy/push-deploy.sh`](../deploy/push-deploy.sh) as `dan@...`
hosts. The gitignored `deploy/.env.local` is kept for local/private
notes and public-fork templates.

---

## Daily deploy

```bash
# Frontend only — Cloudflare Pages auto-deploys every push to main.
git push origin main

# Backend services — uses ./deploy/push-deploy.sh
./deploy/push-deploy.sh                    # already-committed: push then deploy all boxes
./deploy/push-deploy.sh -m "msg"           # add+commit everything then push+deploy
./deploy/push-deploy.sh --only a           # only Box A (skip B + C)
./deploy/push-deploy.sh --only b           # only Box B
./deploy/push-deploy.sh --only c           # only Box C
./deploy/push-deploy.sh --only a --service api
./deploy/push-deploy.sh --skip-remote      # push to GitHub only
```

The script SSHes into each selected box and runs
`/opt/deepmarks-repo/deploy/deploy.sh [a|b|c]` which:

1. `git pull --ff-only`
2. `docker compose build`
3. `docker compose up -d`
4. `docker compose ps`

`docker compose up -d` only recreates a container when its image
changed. **A pure config-file change (e.g. Caddyfile, strfry.conf) is
NOT picked up** — see Gotcha #1.

For routine Box A API-only work, prefer the targeted service path:

```bash
./deploy/push-deploy.sh --only a --service api
```

The remote form is:

```bash
ssh dan@<box-a> '/opt/deepmarks-repo/deploy/deploy.sh a api'
```

That runs `docker compose build api` and
`docker compose up -d --no-deps api`, avoiding an unnecessary
`strfry` source rebuild on the 4 GB Box A host.

---

## Health checks

```bash
# API basic liveness — should return 200 + JSON
curl -s https://api.deepmarks.org/.well-known/lnurlp/zap | head

# Security headers should all be present (added in security batch 3)
curl -sI https://api.deepmarks.org/.well-known/lnurlp/zap | grep -iE \
  'strict-transport|frame-options|content-security-policy|x-content-type|referrer|permissions-policy'

# Box A status
ssh dan@<box-a-public-ip> \
  'docker ps --format "table {{.Names}}\t{{.Status}}"'

# Payment-proxy startup logs
ssh dan@<box-a-public-ip> \
  'cd /opt/deepmarks-repo/deploy/box-a && docker compose logs --tail=50 api'

# Box B archive-worker CPU/memory snapshot
ssh dan@<box-b-public-ip> \
  'docker stats --no-stream box-b-archive-worker-1'
```

---

## Archive Worker Capacity

Box B is the long-tail archive box. Production currently runs on the
Linode Dedicated 4 GB plan with Docker `cpus: "1.5"` and
`MAX_CONCURRENT_JOBS=1` by default. That cap is deliberate: archive
successes upload to Box A and then mirror to Primal, so throughput is
bandwidth-bound before CPU-bound.

Media add-on jobs use `MEDIA_ARCHIVE_TMPDIR=/var/tmp/deepmarks-archive`,
bind-mounted from Box B's encrypted Linode Block Storage volume at
`/mnt/deepmarks-archive-tmp/archive-worker`. The production volume is
100 GB. Keep that on disk, not the 512 MB `/tmp` tmpfs, because
yt-dlp/remux/encrypted chunk files can approach the 2 GB media cap.

Useful queue checks:

```bash
# Pending archive jobs
ssh dan@<box-a-public-ip> \
  'cd /opt/deepmarks-repo/deploy/box-a && pass=$(awk -F= "/^REDIS_PASSWORD=/{print \$2}" .env) && docker compose exec -T -e REDISCLI_AUTH=$pass redis redis-cli LLEN dm:archive:queue'

# In-flight jobs recoverable by archive-worker restart
ssh dan@<box-a-public-ip> \
  'cd /opt/deepmarks-repo/deploy/box-a && pass=$(awk -F= "/^REDIS_PASSWORD=/{print \$2}" .env) && docker compose exec -T -e REDISCLI_AUTH=$pass redis redis-cli --scan --pattern "dm:archive:processing:*"'
```

The user-facing archive UI polls `/account/archive-queue`; high backlog is
acceptable for imports because archives are preservation work, not
realtime page availability.

---

## Rollback

If a deploy lands a regression and you can't fix-forward fast:

```bash
# Find the last-good commit
git log --oneline -10

# Reset locally + push
git reset --hard <good-sha>
git push --force origin main           # force push: warn the team first

# Re-deploy (boxes will git pull --ff-only — that fails because we
# rewrote history; need to reset on each box too):
ssh dan@<box> 'cd /opt/deepmarks-repo && git fetch origin && git reset --hard origin/main'
./deploy/push-deploy.sh --skip-remote   # rebuild + restart with the rolled-back code
```

Force-pushing main is a real cost (anyone with a local clone diverges).
Prefer fix-forward when you can.

---

## Gotchas (read this section before every deploy)

### Gotcha 1: Caddyfile changes need `--force-recreate caddy`

**Symptom:** edited `deploy/box-a/Caddyfile`, deployed, headers / new
sites don't appear in responses.

**Cause:** `compose.yml` bind-mounts the Caddyfile as a single file
(`./Caddyfile:/etc/caddy/Caddyfile:ro`). Bind mounts pin the original
inode at container-start. `git pull` writes a new file with a new
inode; the running container keeps reading the pre-pull content.
`caddy reload --config /etc/caddy/Caddyfile` doesn't help — same
stale inode.

**Fix:**
```bash
ssh dan@<box-a> \
  'cd /opt/deepmarks-repo/deploy/box-a && docker compose up -d --force-recreate caddy'
```

**Verify:**
```bash
# Compare host file hash to container's view
ssh dan@<box-a> 'md5sum /opt/deepmarks-repo/deploy/box-a/Caddyfile && \
                 docker exec box-a-caddy-1 md5sum /etc/caddy/Caddyfile'
# The two hashes should match.
```

Same gotcha potentially applies to other single-file bind mounts
(strfry.conf etc.). Bind-mounted *directories* are fine — Docker
re-reads directory contents.

### Gotcha 2: Fastify version bumps need matching plugin bumps

**Symptom:** `api` crashloops on startup with
`FST_ERR_PLUGIN_VERSION_MISMATCH: @fastify/cors - expected '4.x' fastify version, '5.8.5' is installed`.

**Cause:** Fastify majors and most `@fastify/*` plugins ship coupled
peer-dep ranges. Bumping Fastify alone (e.g. `npm install fastify@5.8.5`)
leaves the cors plugin on its older Fastify-4-only peer. Builds
locally because peer deps are non-fatal in build, dies at runtime.

**Fix:** when bumping Fastify across a major (or near-major), audit
plugin peer ranges:

```bash
cd api
npm ls fastify @fastify/cors  # or any other @fastify/* you use
# Bump every plugin whose peer range no longer covers the new major:
npm install @fastify/cors@latest
```

**Verify:**
```bash
cd api
npm test                # this WILL pass even with the mismatch — peer deps are runtime-only
docker compose -f deploy/box-a/compose.yml build api
# Then deploy + check logs:
ssh dan@<box-a> 'cd /opt/deepmarks-repo/deploy/box-a && docker compose logs --tail=10 api'
```

A clean startup logs `Server listening on http://0.0.0.0:4000` (or
similar). Repeated `FST_ERR_PLUGIN_VERSION_MISMATCH` means a plugin
still doesn't accept this Fastify major.

### Gotcha 3: Boxes diverge from origin after rebases

**Symptom:** `./deploy/push-deploy.sh --only b` fails with
`fatal: Not possible to fast-forward, aborting`. Box B's `git log`
shows commits with subjects you recognize but with SHAs that don't
exist in origin.

**Cause:** at some point local main was rebased (or reset) and
re-pushed; the box never got the matching reset and is sitting on the
pre-rebase line. `git pull --ff-only` refuses because the histories
have actually diverged, even though the *content* is identical.

**Fix:** **before resetting, verify the orphan commits exist in origin
under different SHAs**:

```bash
ssh dan@<box> 'cd /opt/deepmarks-repo && git log origin/main..HEAD --oneline'
# For each subject, check that origin has it:
git log --all --oneline --grep="<subject snippet>" | head
# If every box-only commit has a content-equivalent in origin, the
# reset is safe.
```

Then:

```bash
ssh dan@<box> 'cd /opt/deepmarks-repo && git fetch origin && git reset --hard origin/main'
./deploy/push-deploy.sh --only <box>
```

If even one box-only commit is NOT in origin under another SHA — STOP.
Pull it back via `git format-patch` and apply locally before resetting:

```bash
ssh dan@<box> 'cd /opt/deepmarks-repo && git format-patch -1 <orphan-sha> --stdout' \
  > /tmp/orphan.patch
git am /tmp/orphan.patch     # apply locally
git push origin main         # publish so the box can pull
ssh dan@<box> 'cd /opt/deepmarks-repo && git fetch origin && git reset --hard origin/main'
```

### Gotcha 4: Repeated `Box C` deploys redeploy the bunker

Box C's only role is the nsecBunker. Restarting it briefly drops the
NIP-46 socket, so anything in the middle of a signing roundtrip
returns an error. Not catastrophic — api retries — but
worth doing during low-traffic windows when possible.

### Gotcha 5: `npm audit fix --force` is rarely the right move

The CLI is happy to upgrade Fastify across majors, swap vitest for
v4, replace lightning with v11 — all "breaking" by its own admission.
Most advisories on transitive deps are not exploitable in our usage
(esbuild dev-server bug doesn't matter when we don't run a dev
server in prod). Triage by hand:

```bash
npm audit                                # see the list
npm install <pkg>@<targeted-version>     # bump only what's actually exploitable
```

The pattern that works: identify the High advisories, bump just those,
build, test, deploy. Leave the moderate dev-only ones alone unless
they're actually reachable.

### Gotcha 6: Blossom must use S3, not Box A local disk

**Symptom:** Box A disk usage climbs with archive activity, eventually
threatening Redis, strfry, Caddy, or Docker itself.

**Cause:** Blossom archive bytes were being stored on Box A's local
Docker volume instead of Linode Object Storage. Archive blobs are the
largest, fastest-growing data class and do not belong on the VPS root
disk.

**Fix:** Blossom must start from
[`deploy/box-a/blossom-config.yml`](../deploy/box-a/blossom-config.yml)
with:

```yaml
storage:
  backend: s3
```

and the Box A env must provide `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`,
`LINODE_ACCESS_KEY`, and `LINODE_SECRET_KEY`.

**Verify:**

```bash
ssh dan@<box-a> \
  'docker exec box-a-blossom-server-1 grep -E "backend: s3|bucket:" /app/config.yml'

ssh dan@<box-a> \
  'docker exec box-a-blossom-server-1 sh -lc "du -sh /app/data 2>/dev/null; du -sh /app/data/blobs 2>/dev/null || true"'
```

`/app/data/blobs` should be absent or tiny. A growing blob directory is a
production bug. The `deepmarks` Object Storage bucket is the primary
archive blob store; local Box A disk is only for Redis/strfry state,
Blossom SQLite/config/tmp, logs, and Docker images.

---

## Box-specific notes

### Box A (api + Caddy + strfry + Blossom + Redis + Meilisearch)

- The most complex box. A bad deploy here takes the API down.
- Caddy and Redis run with persistent volumes (`caddy-data`, the redis
  AOF dump). Don't `docker compose down -v` casually — the `-v` wipes
  named volumes including TLS certs and Redis state.
- `CORS_ORIGIN` must include browser and native app origins. Production
  should allow `https://deepmarks.org`, `https://deepmarks.pages.dev`,
  `capacitor://localhost` (iOS), and `https://localhost` (Android). The
  api also appends the native origins in code so mobile API
  reads keep working if the env list is incomplete.
- Redis and strfry backups run nightly via user-level systemd timers
  installed by `deploy/box-a/install-backup-cron.sh`. Backups land in
  Object Storage, the restore test imports the latest backups into
  throwaway containers, and the Object Storage safety timer checks the
  backup bucket's versioning/lifecycle posture.

### Box B (archive-worker)

- Headless Playwright + SingleFile renderer.
- First-run downloads the Chromium bundle (~150MB). Container start
  takes 2–3 minutes on a fresh deploy because of this.
- The worker is stateless — pulls jobs from Redis on Box A. Safe to
  recreate at any time.

### Box C (nsecBunker)

- Holds operational signer nsecs. **Never** add a public port to `compose.yml`.
- Audit log lives in the bunker container (rotates by size).
- Hardening: `deploy/provision/stage1-harden.sh` with role `c`. Run
  this on first provision of any new Box C replacement.

---

## When things go very wrong

1. **Production is down**: roll back (above). Commits are cheap; the
   cost of the wrong decision under pressure is much higher than a
   one-step revert.
2. **Production is degraded but up**: fix-forward. Check
   `docker compose logs --tail=200` on Box A before assuming code —
   half the surprises are env/network drift.
3. **You don't know what changed**: `git log -p HEAD~5..HEAD` shows
   the last 5 commits with diffs. Often the regression is obvious.

If you're not sure what to do, don't deploy more changes — slow down,
read the logs, ping someone.
