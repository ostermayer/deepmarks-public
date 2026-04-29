#!/usr/bin/env node
// One-shot mirror — pulls every kind:39701 bookmark published by anyone in
// the brand's kind:3 contact list and forwards them to relay.deepmarks.org.
//
// Run manually whenever you want the home relay caught up:
//
//   node scripts/sync-follow-bookmarks.mjs
//
// Why no daemon: kind:39701 adoption outside Deepmarks is currently thin
// (the brand follows ~191 pubkeys and only ~17 bookmarks exist among them
// across the major public relays). A scheduled job would mostly idle. When
// NIP-B0 picks up, swap this for a systemd timer or docker compose service
// — the script is idempotent (only publishes events the relay doesn't
// already have), so running it more often is safe.
//
// Scope is intentionally narrow:
//   - kind:39701 only (bookmarks; matches the relay's open allowlist)
//   - authors limited to whoever the brand follows right now
//   - skips events already on the target relay
//
// Other event kinds from non-team pubkeys are rejected by the relay's
// writePolicy (deploy/box-a/strfry/deepmarks.js) — by design, this script
// doesn't try to publish them.

import WebSocket from 'ws';

const BRAND = process.env.DEEPMARKS_BRAND_PUBKEY
  ?? '2944e915ba71cf0fc19f5dda048ce053a87c01fd7478b179330a17edca4ce2f4';
const SOURCES = (process.env.DEEPMARKS_SOURCE_RELAYS
  ?? 'wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net')
  .split(',').map((s) => s.trim()).filter(Boolean);
const TARGET = process.env.DEEPMARKS_TARGET_RELAY ?? 'wss://relay.deepmarks.org';

function pull(url, filter, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const events = [];
    const sub = 'q' + Math.random().toString(36).slice(2, 8);
    const timer = setTimeout(() => { try { ws.close(); } catch {} }, timeoutMs);
    ws.on('open', () => ws.send(JSON.stringify(['REQ', sub, filter])));
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg[0] === 'EVENT' && msg[1] === sub) events.push(msg[2]);
        if (msg[0] === 'EOSE'  && msg[1] === sub) { clearTimeout(timer); ws.close(); }
      } catch {}
    });
    ws.on('close', () => resolve(events));
    ws.on('error', () => resolve(events));
  });
}

async function main() {
  // 1) Read brand follow list from the target relay (canonical home).
  const [k3] = await pull(TARGET, { authors: [BRAND], kinds: [3], limit: 1 });
  if (!k3) { console.error('no kind:3 found for brand pubkey on ' + TARGET); process.exit(1); }
  const follows = k3.tags
    .filter((t) => t[0] === 'p' && /^[0-9a-f]{64}$/.test(t[1]))
    .map((t) => t[1]);
  console.log('Brand follows: ' + follows.length + ' pubkeys');
  if (follows.length === 0) return;

  // 2) Discover kind:39701 events from those authors on public relays.
  const seen = new Map();
  for (const url of SOURCES) {
    let count = 0;
    for (let i = 0; i < follows.length; i += 50) {
      const batch = follows.slice(i, i + 50);
      const events = await pull(url, { kinds: [39701], authors: batch, limit: 500 });
      events.forEach((e) => seen.set(e.id, e));
      count += events.length;
    }
    console.log('  ' + url + ' returned ' + count + ' events (pre-dedup)');
  }
  console.log('Unique events from follows: ' + seen.size);

  // 3) Skip what we already have.
  const onTarget = new Set();
  for (let i = 0; i < follows.length; i += 50) {
    const batch = follows.slice(i, i + 50);
    const events = await pull(TARGET, { kinds: [39701], authors: batch, limit: 500 });
    events.forEach((e) => onTarget.add(e.id));
  }
  const toPublish = [...seen.values()].filter((e) => !onTarget.has(e.id));
  console.log('Already on target: ' + onTarget.size + '   to publish: ' + toPublish.length);
  if (toPublish.length === 0) return;

  // 4) Publish over a single connection.
  const ws = new WebSocket(TARGET);
  await new Promise((r) => ws.on('open', r));
  let ok = 0, dup = 0, replaced = 0, rate = 0, fail = 0;
  const pending = new Map();

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg[0] !== 'OK') return;
      const [, id, accepted, reason] = msg;
      if (!pending.has(id)) return;
      const settle = pending.get(id);
      pending.delete(id);
      if (accepted) { ok++; settle(); return; }
      if (/duplicate|already have/i.test(reason ?? '')) { dup++; settle(); return; }
      if (/replaced|newer event/i.test(reason ?? ''))   { replaced++; settle(); return; }
      if (/rate limit/i.test(reason ?? ''))             { rate++; settle(); return; }
      fail++;
      if (fail <= 5) console.log('  FAIL ' + id.slice(0, 12) + ' — ' + reason);
      settle();
    } catch {}
  });

  for (const ev of toPublish) {
    const p = new Promise((settle) => {
      pending.set(ev.id, settle);
      setTimeout(() => {
        if (pending.has(ev.id)) { pending.delete(ev.id); fail++; settle(); }
      }, 5000);
    });
    ws.send(JSON.stringify(['EVENT', ev]));
    await p;
  }
  ws.close();

  console.log('');
  console.log('accepted=' + ok
    + '  duplicate=' + dup
    + '  replaced=' + replaced
    + '  rate-limited=' + rate
    + '  failed=' + fail);
}

main().catch((e) => { console.error(e); process.exit(1); });
