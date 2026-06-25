#!/usr/bin/env node
// Publish the current built extension to Mozilla addons.mozilla.org.
//
// Uses the AMO Add-on Submission API v5:
//   https://addons-server.readthedocs.io/en/latest/topics/api/addons.html#submit-version
//
// Required env vars:
//   AMO_JWT_ISSUER     JWT issuer (user key) — from addons.mozilla.org/developers/addon/api/key/
//   AMO_JWT_SECRET     JWT secret
//   AMO_ADDON_SLUG     Listing slug (or addon GUID), e.g. "deepmarks"
//
// Optional:
//   AMO_ZIP_PATH       path to the .zip to upload
//                      (default: firefox/deepmarks-firefox.zip)
//   AMO_CHANNEL        "listed" (public AMO) or "unlisted" (self-distributed)
//                      (default: "listed")
//
// Flow:
//   1. Mint a short-lived JWT signed with the AMO secret.
//   2. POST /api/v5/addons/upload/ with the .zip — returns an upload UUID.
//   3. Poll the upload until `valid: true` (AMO validation pass).
//   4. POST /api/v5/addons/addon/<slug>/versions/ pointing at the upload.

import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const need = (name) => {
  const v = process.env[name];
  if (!v) {
    console.error(`✗ missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
};

const ISSUER = need('AMO_JWT_ISSUER');
const SECRET = need('AMO_JWT_SECRET');
const SLUG = need('AMO_ADDON_SLUG');
const ZIP_PATH = resolve(REPO_ROOT, process.env.AMO_ZIP_PATH ?? 'firefox/deepmarks-firefox.zip');
const CHANNEL = process.env.AMO_CHANNEL ?? 'listed';

const API = 'https://addons.mozilla.org/api/v5';

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replaceAll('=', '')
    .replaceAll('+', '-')
    .replaceAll('/', '_');
}

/** Mint a fresh JWT for one API call. AMO docs explicitly require a
 *  short-lived JWT signed per-request (max 5 min), not reusing a
 *  long-lived token. */
function mintJwt() {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({
    iss: ISSUER,
    jti: `${now}-${Math.random().toString(36).slice(2, 10)}`,
    iat: now,
    exp: now + 60,
  }));
  const sig = b64url(createHmac('sha256', SECRET).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `JWT ${mintJwt()}`,
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function uploadZip() {
  const stats = await stat(ZIP_PATH);
  console.log(`→ uploading ${ZIP_PATH} (${(stats.size / 1024).toFixed(1)} KB) channel=${CHANNEL}`);
  const zip = await readFile(ZIP_PATH);
  const form = new FormData();
  form.append('upload', new Blob([zip], { type: 'application/zip' }), 'extension.zip');
  form.append('channel', CHANNEL);
  const result = await api('/addons/upload/', { method: 'POST', body: form });
  return result.uuid;
}

async function pollValidation(uuid) {
  console.log(`→ polling AMO validation for upload ${uuid}`);
  const start = Date.now();
  const timeoutMs = 5 * 60 * 1000; // 5 min
  while (Date.now() - start < timeoutMs) {
    const result = await api(`/addons/upload/${uuid}/`);
    if (result.processed) {
      if (!result.valid) {
        const errors = result.validation?.messages
          ?.filter((m) => m.type === 'error')
          ?.map((m) => `  • ${m.message}`)
          ?.join('\n') ?? '(no detail)';
        throw new Error(`validation failed:\n${errors}`);
      }
      console.log(`✓ AMO validation pass (${Math.round((Date.now() - start) / 1000)}s)`);
      return;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error('validation timed out after 5 min');
}

async function createVersion(uuid) {
  console.log(`→ creating new version for addon=${SLUG}`);
  const body = JSON.stringify({ upload: uuid });
  const result = await api(`/addons/addon/${SLUG}/versions/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  console.log(`✓ submitted version ${result.version} (id ${result.id})`);
  if (CHANNEL === 'listed') {
    console.log('  AMO review queue picks it up; can take hours to days.');
  }
}

async function main() {
  const uuid = await uploadZip();
  await pollValidation(uuid);
  await createVersion(uuid);
  console.log('✓ submitted to Mozilla Add-ons');
}

main().catch((err) => {
  console.error(`✗ ${err.message ?? err}`);
  process.exit(1);
});
