# Operational monitoring

Three layers of "tell the operator something is wrong" — see
`docs/architecture.md` for context. Goal: zero SaaS dependency, email
delivery via the same Resend integration the abuse-report flow uses.

## Layers

| Tier | What | Where |
|---|---|---|
| 1 | App-level alerts (uncaught 5xx, BTCPay anomalies, archive-callback owner mismatch, LND circuit trip, archive-enqueue rollback) | `api/src/alerter.ts` — debounced via Redis, integrated into route handlers |
| 2 | Uptime probes (Box A `/health`, relay write health, archive queue/worker health, Box C bunker `/health`) | `deepmarks-uptime-check` — runs every 5 min via cron on Box C |
| 3 | Host resource alerts (disk > 80 %, memory > 90 %, container restart loops, backup/restore failures, Redis persistence failures, Blossom local-storage fallback, macaroon age, deleted-but-open fd space on Box B archive-tmp, strfry replica freshness on Box B, strfry-stream sidecar watchdog + auto-revive on Box A) | `deepmarks-resource-check` — runs every 15 min via cron on every box |

## Files

- `deepmarks-alert` — sender helper. Reads `/etc/deepmarks-monitoring.env`. Per-key debouncing via mtime on a marker file in `/var/lib/deepmarks-alert/`.
- `deepmarks-uptime-check` — probes the three boxes. Three-strike alerting: only fires after 3 consecutive failures so a single transient blip doesn't email.
- `deepmarks-resource-check` — disk + memory + container restart + Box A data-durability + macaroon-age checks; on Box B also space pinned by deleted-but-open fds on the archive-tmp mount (invisible to `du`; see `docs/incidents/2026-07-20-archive-tmp-fd-leak.md`).
- `install.sh` — copies scripts to `/usr/local/bin`, writes a template `/etc/deepmarks-monitoring.env` (chmod 600), installs the right cron entries for the box.

## Install

On each box, as root:

```bash
ssh dan@<box> 'cd /opt/deepmarks-repo/deploy/monitoring && sudo BOX=a ./install.sh'  # adjust BOX
```

After install, edit `/etc/deepmarks-monitoring.env` to fill in `RESEND_API_KEY` and `REDIS_PASSWORD` on Box A. Verify with:

```bash
sudo /usr/local/bin/deepmarks-alert info test "install verified" "Install ran on $(hostname)"
```

You should receive an email to `ALERT_EMAIL` within a few seconds.

## App-level alert env

Tier-1 app alerts are sent by `api` itself, not by the cron
monitoring scripts. Box A's `deploy/box-a/compose.yml` passes
`ALERT_EMAIL` into the container; keep the same operator address in
`/opt/deepmarks-repo/deploy/box-a/.env` that you use in
`/etc/deepmarks-monitoring.env`, alongside `RESEND_API_KEY` and
`EMAIL_FROM`.

If api starts with app alerts disabled, its logs include:

```text
[alerter] no recipient configured
```

After changing Box A's `.env`, restart only api:

```bash
ssh dan@<box-a> \
  'cd /opt/deepmarks-repo/deploy/box-a && docker compose up -d --no-deps api'
```

## Tuning

- **Debounce window** — set `DEDUP_SECONDS` in the env file. Default 600 (10 min) per (severity, key) pair.
- **Disk threshold** — edit `DISK_PCT_LIMIT` in `deepmarks-resource-check` (default 80).
- **Memory threshold** — edit `MEM_PCT_LIMIT` (default 90).
- **Blossom local blob threshold** — edit `BLOSSOM_LOCAL_BLOBS_MB_LIMIT` in `deepmarks-resource-check` (default 256 MB).
- **Archive-tmp deleted-fd threshold** — edit `ARCHIVE_TMP_DELETED_MB_LIMIT` in `deepmarks-resource-check` (default 10 GB; only probes where `ARCHIVE_TMP_MOUNT` is a mountpoint, i.e. Box B).
- **Backup freshness threshold** — edit `BACKUP_SERVICE_MAX_AGE_SECONDS` in `deepmarks-resource-check` (default 48 hours).
- **Replica freshness threshold** — edit `REPLICA_MAX_EVENT_AGE_SECONDS` in `deepmarks-resource-check` (default 1 hour; production's worst measured inter-event gap over 14 days was 24 min, so don't set below ~30 min).
- **Uptime strikes** — edit `THRESHOLD` in `deepmarks-uptime-check` (default 3 consecutive failures).
- **Tier-1 hourly ceiling** — `api/src/alerter.ts` `DEFAULT_HOURLY_CEILING` (default 50). Global brake against alert storms.

## Relay uptime — defense in depth

The relay (`strfry` on Box A) is the single hardest-dependency the app
has — web, iOS, and extension all only talk to
`wss://relay.deepmarks.org`. Four layers keep it serving:

1. **Docker `restart: unless-stopped`** — process exits get restarted
   immediately by Docker. Handles crashes / OOM kills.
2. **Compose `healthcheck` on strfry** — a node TCP probe to port 7777
   every 15s. Marks the container `unhealthy` if the WS port stops
   accepting connections (e.g. a deadlocked process that didn't crash).
3. **`autoheal` sidecar** — watches container health labels and
   restarts any container that goes `unhealthy`. Pairs with the
   healthcheck so a wedged relay self-recovers within ~30s with no
   operator action.
4. **Tier-2 `deepmarks-uptime-check`** — probes `relay.deepmarks.org`
   from Box C every 5 min. Pages the operator after 3 consecutive
   failures (≈15 min), which is the failure-mode catch-all if layers
   1–3 all somehow miss something (host networking, Caddy crash, full
   disk preventing restart, etc.).

## Replication stream — defense in depth

The Box A → Box B strfry replication stream has its own layers,
because a strfry crash kills the pid-namespace-sharing `strfry-stream`
sidecar with it and Docker's restart can strand the sidecar `Exited`
(the pid-ns join races the relay's own restart — see
`docs/incidents/2026-08-04-strfry-replica-stale-sidecar-strand.md`):

1. **Docker `restart: unless-stopped`** on the sidecar — covers clean
   crashes when the join race doesn't bite.
2. **Box A watchdog** in `deepmarks-resource-check` — if replication is
   enabled (`COMPOSE_PROFILES` contains `replication`) and the sidecar
   isn't running, it runs `docker compose --profile replication up -d
   --no-deps strfry-stream`, reconciles the gap with `strfry sync
   --dir up`, and emails `strfry-stream-revived` (warning) or
   `strfry-stream-revive-failed` (critical). Worst-case strand: 15 min.
3. **Box B freshness probe** (`strfry-replica-stale`, warning) — no
   event on the replica for `REPLICA_MAX_EVENT_AGE_SECONDS` (1h). The
   traffic-independent backstop for failure modes the watchdog can't
   see: router connected-but-wedged, firewall regression, replica
   rejecting writes.
4. **Daily set-divergence probe** (Box A, 03:0x run) — read-only
   negentropy comparison (`strfry sync --dir none`); alerts
   `strfry-replica-divergence` when the primary and replica hold
   different event SETS, which no freshness or count-window probe can
   see (`docs/incidents/2026-08-05-replica-surplus-event.md`). Run
   manually with `REPLICA_DIVERGENCE_FORCE=1 deepmarks-resource-check`.

If you ever need to test that the chain works end-to-end on a staging
box:

```bash
ssh root@<box-a> 'docker kill --signal=SIGSTOP box-a-strfry-1'
```

That suspends the process without killing it, so healthcheck fires
unhealthy → autoheal restarts → relay is back. Don't run on prod.

## What's NOT alerted (by design, today)

- Bunker disconnects — they auto-reconnect within seconds. The Tier-2 uptime probe catches sustained bunker outages; transient blips would be alert noise.
- Per-request 4xx — those are user errors, not operator concerns.
- Single LND `invoice_updated` retry — circuit breaker handles flapping, only alerts on a TRIP.
- Strfry write rejections — already returned to the publishing client.

If you want any of these wired in later, the alerter API in
`api/src/alerter.ts` is the entry point — just add another
`alerter.alert(...)` call site.

## Failure mode of the alerter itself

The `Alerter` interface explicitly never throws — a Resend API outage,
a malformed dedup key, or a Redis hiccup all log an `[alerter] alert
send failed` ERROR and return cleanly. **If you stop seeing alert
emails AND the application is still serving traffic, suspect Resend or
the API key.** Tail `docker logs box-a-api-1 | grep alerter`
to see the actual cause.
