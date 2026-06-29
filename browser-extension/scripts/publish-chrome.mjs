#!/usr/bin/env node
// Publish the current built extension to the Chrome Web Store.
//
// Uses the Chrome Web Store Publish API:
//   https://developer.chrome.com/docs/webstore/using-the-api
//
// Required env vars (configure once, then forget):
//   CHROME_EXTENSION_ID      The store listing ID
//   CHROME_CLIENT_ID         OAuth2 client_id (from Google Cloud Console)
//   CHROME_CLIENT_SECRET     OAuth2 client_secret
//   CHROME_REFRESH_TOKEN     OAuth2 refresh_token (one-time auth dance)
//
// Optional:
//   CHROME_PUBLISH_TARGET    "default" (public) or "trustedTesters"
//                            (default: "default")
//   CHROME_ZIP_PATH          path to the .zip to upload
//                            (default: chrome/deepmarks-chrome.zip)
//
// Flow:
//   1. Refresh the OAuth access token using the refresh_token.
//   2. PUT the .zip to upload/chromewebstore/v1.1/items/<id>.
//   3. POST chromewebstore/v1.1/items/<id>/publish.
//
// Run locally:
//   npm run package:chrome                              # build + zip
//   node scripts/publish-chrome.mjs                     # upload + publish

import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const EXTENSION_ID = need('CHROME_EXTENSION_ID');
const CLIENT_ID = need('CHROME_CLIENT_ID');
const CLIENT_SECRET = need('CHROME_CLIENT_SECRET');
const REFRESH_TOKEN = need('CHROME_REFRESH_TOKEN');
const PUBLISH_TARGET = process.env.CHROME_PUBLISH_TARGET ?? 'default';
const ZIP_PATH = resolve(REPO_ROOT, process.env.CHROME_ZIP_PATH ?? 'chrome/deepmarks-chrome.zip');

async function getAccessToken() {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });
  const res = await fetch('https://www.googleapis.com/oauth2/v4/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    throw new Error(`oauth refresh failed: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  if (!json.access_token) {
    throw new Error(`oauth refresh: no access_token in response: ${JSON.stringify(json)}`);
  }
  return json.access_token;
}

async function uploadZip(token) {
  const stats = await stat(ZIP_PATH);
  console.log(`→ uploading ${ZIP_PATH} (${(stats.size / 1024).toFixed(1)} KB)`);
  const zip = await readFile(ZIP_PATH);
  const res = await fetch(
    `https://www.googleapis.com/upload/chromewebstore/v1.1/items/${EXTENSION_ID}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'x-goog-api-version': '2',
      },
      body: zip,
    },
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`upload failed: ${res.status} ${text}`);
  }
  const json = JSON.parse(text);
  if (json.uploadState !== 'SUCCESS') {
    throw new Error(`upload uploadState=${json.uploadState}: ${text}`);
  }
  console.log(`✓ upload accepted (item id ${json.id})`);
}

async function publish(token) {
  console.log(`→ publishing to target=${PUBLISH_TARGET}`);
  const res = await fetch(
    `https://www.googleapis.com/chromewebstore/v1.1/items/${EXTENSION_ID}/publish?publishTarget=${PUBLISH_TARGET}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'x-goog-api-version': '2',
        'Content-Length': '0',
      },
    },
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`publish failed: ${res.status} ${text}`);
  }
  const json = JSON.parse(text);
  console.log(`✓ publish status: ${(json.status ?? []).join(', ')}`);
  if (json.statusDetail) console.log(`  detail: ${(json.statusDetail ?? []).join('; ')}`);
}

async function main() {
  const token = await getAccessToken();
  await uploadZip(token);
  await publish(token);
  console.log('✓ published to Chrome Web Store');
}

main().catch((err) => {
  console.error(`✗ ${err.message ?? err}`);
  process.exit(1);
});
