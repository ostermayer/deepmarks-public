#!/usr/bin/env node
/**
 * Deepmarks admin CLI.
 *
 * Signs a NIP-98 (kind:27235) auth event with the admin nsec, then issues
 * the matching HTTP request to api.deepmarks.org. The nsec stays on the
 * caller's machine; the server only ever sees the signed credential.
 *
 * Usage:
 *   ./deploy/admin.mjs <command> [args...]
 *
 * Commands:
 *   members                       List current lifetime members
 *   reconcile                     Rebuild lifetime members from BTCPay
 *   stamp <npub|hex> [paidAt]     Manually grant lifetime to a pubkey
 *   status <npub|hex>             Check lifetime status of any pubkey (no auth)
 *
 * Reads the nsec from the first one of:
 *   $DEEPMARKS_ADMIN_NSEC                     literal nsec1... or hex
 *   $DEEPMARKS_ADMIN_NSEC_FILE                path to a file containing the nsec
 *   ./deepmarks-admin-nsec.txt                fallback in repo root
 *
 * The API base defaults to https://api.deepmarks.org; override with
 * $DEEPMARKS_API_BASE (e.g. http://localhost:4000 for dev).
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Borrow nostr-tools from the api install — saves bootstrapping
// a separate dependency tree just for this script.
const NOSTR_PATH = resolve(__dirname, '..', 'api', 'node_modules', 'nostr-tools');
if (!existsSync(NOSTR_PATH)) {
  console.error(`✗ nostr-tools not found at ${NOSTR_PATH}`);
  console.error('  run: cd api && npm install');
  process.exit(1);
}
const { finalizeEvent, getPublicKey, nip19 } = require(NOSTR_PATH);

const API_BASE = (process.env.DEEPMARKS_API_BASE ?? 'https://api.deepmarks.org').replace(/\/+$/, '');

function loadSecretKey() {
  const literal = process.env.DEEPMARKS_ADMIN_NSEC;
  const candidates = [
    literal,
    process.env.DEEPMARKS_ADMIN_NSEC_FILE && readMaybe(process.env.DEEPMARKS_ADMIN_NSEC_FILE),
    readMaybe(resolve(__dirname, '..', 'deepmarks-admin-nsec.txt')),
  ].filter(Boolean);
  const rawText = candidates[0]?.toString().trim();
  if (!rawText) {
    console.error('✗ no admin nsec found. Set DEEPMARKS_ADMIN_NSEC, DEEPMARKS_ADMIN_NSEC_FILE,');
    console.error('  or place the nsec at ./deepmarks-admin-nsec.txt (repo root).');
    process.exit(1);
  }
  // Some local secret files include labels or both npub/nsec lines.
  // Extract the actual secret token without requiring the file to be
  // exactly one bare value.
  const raw = rawText.match(/nsec1[023456789acdefghjklmnpqrstuvwxyz]+|[0-9a-f]{64}/i)?.[0]
    ?? rawText;
  if (raw.startsWith('nsec1')) {
    const decoded = nip19.decode(raw);
    if (decoded.type !== 'nsec') throw new Error('not an nsec');
    return decoded.data;
  }
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    return Uint8Array.from(Buffer.from(raw, 'hex'));
  }
  throw new Error('admin nsec must be nsec1... or 64-char hex');
}

function readMaybe(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

function decodePubkey(input) {
  const trimmed = input.trim();
  if (trimmed.startsWith('npub1')) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== 'npub') throw new Error('not an npub');
    return decoded.data;
  }
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
  throw new Error('pubkey must be npub1... or 64-char hex');
}

async function nip98Request(method, path, body) {
  const sk = loadSecretKey();
  const url = `${API_BASE}${path}`;
  const rawBody = body !== undefined ? JSON.stringify(body) : undefined;
  const tags = [
    ['u', url],
    ['method', method.toUpperCase()],
  ];
  if (rawBody !== undefined) {
    tags.push(['payload', createHash('sha256').update(rawBody).digest('hex')]);
  }
  const event = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: '',
    },
    sk,
  );
  const auth = 'Nostr ' + Buffer.from(JSON.stringify(event)).toString('base64');
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: auth,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: rawBody,
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  console.log(`HTTP ${res.status}`);
  console.log(typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2));
  process.exit(res.ok ? 0 : 1);
}

async function publicGet(path) {
  const res = await fetch(`${API_BASE}${path}`);
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  console.log(`HTTP ${res.status}`);
  console.log(typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2));
  process.exit(res.ok ? 0 : 1);
}

function usage() {
  console.error('usage: admin.mjs <members|reconcile|stamp|status> [args]');
  console.error('  members                      list lifetime members');
  console.error('  reconcile                    rebuild lifetime store from BTCPay');
  console.error('  stamp <npub|hex> [paidAt]    manually grant lifetime');
  console.error('  status <npub|hex>            check lifetime status (no auth)');
  console.error('  archive-rescue [--run] [--force] [--limit=N] [--pubkey=npub]');
  console.error('                               re-run archive rescue (dry-run unless --run)');
  process.exit(2);
}

const [, , cmd, ...args] = process.argv;
switch (cmd) {
  case 'members':
    await nip98Request('GET', '/admin/lifetime/members');
    break;
  case 'reconcile':
    await nip98Request('POST', '/admin/lifetime/reconcile');
    break;
  case 'stamp': {
    if (args.length === 0) usage();
    const pubkey = decodePubkey(args[0]);
    const paidAt = args[1] ? Number.parseInt(args[1], 10) : undefined;
    await nip98Request('POST', '/admin/lifetime/stamp', paidAt ? { pubkey, paidAt } : { pubkey });
    break;
  }
  case 'status': {
    if (args.length === 0) usage();
    const pubkey = decodePubkey(args[0]);
    await publicGet(`/account/lifetime/status?pubkey=${pubkey}`);
    break;
  }
  case 'archive-rescue': {
    // Re-run the archive-rescue pass over recorded failures (finds public
    // alternatives — Wayback, scholarly PDFs, x.com mirrors, etc.).
    // Dry-run by default; pass --run to actually enqueue. --force ignores
    // the per-failure claim lock so already-attempted failures are retried
    // with the latest rescue logic.
    const run = args.includes('--run');
    const force = args.includes('--force');
    const limitArg = args.find((a) => a.startsWith('--limit='));
    const pubArg = args.find((a) => a.startsWith('--pubkey='));
    const body = { dryRun: !run, force };
    if (limitArg) body.limit = Number.parseInt(limitArg.split('=')[1], 10);
    if (pubArg) body.pubkey = decodePubkey(pubArg.split('=')[1]);
    await nip98Request('POST', '/admin/archive-rescue/run', body);
    break;
  }
  default:
    usage();
}
