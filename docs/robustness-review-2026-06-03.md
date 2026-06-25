# Robustness review: Redis queues, archive callbacks, and archive icons

> **Historical snapshot (pre-June-2026 reliability program).** Current
> coverage catalog: [`../tests/README.md`](../tests/README.md); current
> posture: [`reliability-2026-06.md`](reliability-2026-06.md).

Date: 2026-06-03

This review followed the archive-icon and sync-durability incident work.
The focus was silent data loss risks: places where the app could tell a
client "accepted" while a queue write, callback, or visibility decision
had actually failed.

## Fixed invariants

- Load-bearing Redis `multi()/pipeline` writes must inspect per-command
  errors. `ioredis` can resolve `exec()` even when an individual command
  failed. Payment-proxy and archive-worker now use shared `execOrThrow`
  helpers for publish admission, relay retry queues, private mark writes,
  and archive queue state transitions.
- `/publish` must return a hard failure if the relay queue write fails.
  A bookmark event is only accepted once it is actually queued for the
  relay worker.
- Archive-worker orphan recovery must not requeue another live worker's
  processing list. `recoverOrphans()` only reclaims
  `dm:archive:processing:<wid>` when the matching
  `dm:archive:active:<wid>` heartbeat is absent. A second startup
  recovery pass runs after the heartbeat TTL so just-crashed workers are
  still reclaimed without another restart.
- Terminal archive failures must not lose the Box A callback. If
  `payment-proxy` does not accept the failure callback, the worker writes
  a durable `callbackPending` flag into `dm:archive:done:<jobId>`. The
  archive audit loop retries the failure callback and clears the flag
  after acknowledgement.
- Missing private archive keys are repair/decrypt state, not archive
  existence state. Bookmark rows no longer use local missing-key memory
  to hide a completed `blossom` archive icon.
- Private bookmark refresh no longer logs private bookmark URLs in the
  browser console.

## Tests added

- `payment-proxy/src/redis-exec.test.ts` covers Redis command-level
  pipeline errors and null exec results.
- `archive-worker/src/queue.test.ts` covers dead processing-list recovery
  while skipping live active workers.
- `archive-worker/src/worker.test.ts` covers terminal failure records
  with pending callbacks and audit-loop re-delivery.

## Remaining review targets

- Extract shared API/archive contracts across frontend, browser
  extension, payment-proxy, and archive-worker so archive record fields
  cannot drift silently.
- Add integration coverage around full publish acceptance and relay
  fanout retry queues, not only the Redis helper and retry planner.
- Add multi-pass archive audit cursor tests and corrupt queue-entry tests.
