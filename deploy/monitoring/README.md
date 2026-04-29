# Operational monitoring

Three layers of "tell the operator something is wrong" — see
`docs/architecture.md` for context. Goal: zero SaaS dependency, email
delivery via the same Resend integration the abuse-report flow uses.

## Layers

| Tier | What | Where |
|---|---|---|
| 1 | App-level alerts (uncaught 5xx, BTCPay anomalies, archive-callback owner mismatch, Voltage circuit trip, archive-enqueue rollback) | `payment-proxy/src/alerter.ts` — debounced via Redis, integrated into route handlers |
| 2 | Uptime probes (Box A `/health`, Box B archive-worker heartbeat, Box C bunker `/health`) | `deepmarks-uptime-check` — runs every 5 min via cron on Box C |
| 3 | Host resource alerts (disk > 80 %, memory > 90 %, container restart loops, macaroon age) | `deepmarks-resource-check` — runs every 15 min via cron on every box |

## Files

- `deepmarks-alert` — sender helper. Reads `/etc/deepmarks-monitoring.env`. Per-key debouncing via mtime on a marker file in `/var/lib/deepmarks-alert/`.
- `deepmarks-uptime-check` — probes the three boxes. Three-strike alerting: only fires after 3 consecutive failures so a single transient blip doesn't email.
- `deepmarks-resource-check` — disk + memory + container restart + macaroon-age checks.
- `install.sh` — copies scripts to `/usr/local/bin`, writes a template `/etc/deepmarks-monitoring.env` (chmod 600), installs the right cron entries for the box.

## Install

On each box, as root:

```bash
ssh dan@<box> 'cd /opt/deepmarks-repo/deploy/monitoring && sudo BOX=a ./install.sh'  # adjust BOX
```

After install, edit `/etc/deepmarks-monitoring.env` to fill in `RESEND_API_KEY` (and `REDIS_PASSWORD` on Box C). Verify with:

```bash
sudo /usr/local/bin/deepmarks-alert info test "install verified" "Install ran on $(hostname)"
```

You should receive an email to `ALERT_EMAIL` within a few seconds.

## Tuning

- **Debounce window** — set `DEDUP_SECONDS` in the env file. Default 600 (10 min) per (severity, key) pair.
- **Disk threshold** — edit `DISK_PCT_LIMIT` in `deepmarks-resource-check` (default 80).
- **Memory threshold** — edit `MEM_PCT_LIMIT` (default 90).
- **Uptime strikes** — edit `THRESHOLD` in `deepmarks-uptime-check` (default 3 consecutive failures).
- **Tier-1 hourly ceiling** — `payment-proxy/src/alerter.ts` `DEFAULT_HOURLY_CEILING` (default 50). Global brake against alert storms.

## What's NOT alerted (by design, today)

- Bunker disconnects — they auto-reconnect within seconds. The Tier-2 uptime probe catches sustained bunker outages; transient blips would be alert noise.
- Per-request 4xx — those are user errors, not operator concerns.
- Single LND `invoice_updated` retry — circuit breaker handles flapping, only alerts on a TRIP.
- Strfry write rejections — already returned to the publishing client.

If you want any of these wired in later, the alerter API in
`payment-proxy/src/alerter.ts` is the entry point — just add another
`alerter.alert(...)` call site.

## Failure mode of the alerter itself

The `Alerter` interface explicitly never throws — a Resend API outage,
a malformed dedup key, or a Redis hiccup all log an `[alerter] alert
send failed` ERROR and return cleanly. **If you stop seeing alert
emails AND the application is still serving traffic, suspect Resend or
the API key.** Tail `docker logs box-a-payment-proxy-1 | grep alerter`
to see the actual cause.
