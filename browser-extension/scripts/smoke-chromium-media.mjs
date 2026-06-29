#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const QUEUED_PREFIX = 'deepmarks-media-archive-queued:v1:';

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.log('SKIP: Chrome/Chromium not found. Set CHROME_BIN to run the extension smoke test.');
    return;
  }
  if (!existsSync(join(DIST, 'manifest.json'))) {
    throw new Error('dist/manifest.json missing; run npm run build:chrome first');
  }

  const tmpRoot = process.env.DEEPMARKS_EXTENSION_SMOKE_TMP || tmpdir();
  const work = await mkdtemp(join(tmpRoot, 'deepmarks-extension-smoke-'));
  const extensionDir = join(work, 'extension');
  const sourceDir = join(work, 'source');
  await mkdir(sourceDir, { recursive: true });
  await cp(DIST, extensionDir, { recursive: true });

  const entry = join(sourceDir, 'media-smoke.ts');
  const mockArchive = join(sourceDir, 'mock-archive.ts');
  const mockArchiveKeys = join(sourceDir, 'mock-archive-keys.ts');
  const mockReconciler = join(sourceDir, 'mock-reconciler.ts');

  await writeFile(mockArchive, `
export async function archiveStatus() {
  return { status: 'queued', state: 'queued' };
}
export async function getMediaArchiveAddonStatus() {
  return { purchased: true, paidAt: 1, amountSats: 0 };
}
export async function startMediaArchive(input) {
  const smoke = globalThis.__deepmarksSmoke;
  smoke.archiveCalls.push(input);
  const n = smoke.archiveCalls.length;
  return { paymentHash: 'smoke-' + n, jobId: 'job-' + n, amountSats: 0, canonicalUrl: input.url };
}
`);
  await writeFile(mockArchiveKeys, `
export function generateArchiveKey() {
  return 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
}
export async function publishPendingArchiveKey(jobId, archiveKey) {
  globalThis.__deepmarksSmoke.publishedKeys.push({ jobId, archiveKey });
}
export async function stashPendingKey(jobId, archiveKey) {
  globalThis.__deepmarksSmoke.stashedKeys.push({ jobId, archiveKey });
}
`);
  await writeFile(mockReconciler, `
export function scheduleArchiveKeyReconcileSoon() {
  globalThis.__deepmarksSmoke.reconcileScheduled += 1;
}
`);
  await writeFile(entry, `
import { isPotentialMediaUrl, queueEligibleMediaArchiveBackfill } from ${JSON.stringify(join(ROOT, 'src/lib/media-archive.ts'))};

globalThis.__deepmarksSmoke = {
  archiveCalls: [],
  publishedKeys: [],
  stashedKeys: [],
  reconcileScheduled: 0,
};

function promisifyStorageArea(area) {
  for (const method of ['get', 'set', 'remove', 'clear']) {
    const original = area[method].bind(area);
    area[method] = (...args) => {
      const last = args[args.length - 1];
      if (typeof last === 'function') return original(...args);
      return new Promise((resolve, reject) => {
        original(...args, (value) => {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve(value);
        });
      });
    };
  }
}

promisifyStorageArea(chrome.storage.local);

async function run() {
  await chrome.storage.local.clear();
  const youtube = 'https://www.youtube.com/watch?v=AbCdEfGhI12';
  const youtubeDuplicate = 'https://youtu.be/AbCdEfGhI12';
  const audio = 'https://cdn.example.com/podcast/episode.mp3';
  const nonMedia = 'https://www.youtube.com/@deepmarks';

  if (!isPotentialMediaUrl(youtube)) throw new Error('YouTube watch URL was not detected as media');
  if (!isPotentialMediaUrl(audio)) throw new Error('direct audio URL was not detected as media');
  if (isPotentialMediaUrl(nonMedia)) throw new Error('YouTube channel URL was incorrectly detected as media');

  const result = await queueEligibleMediaArchiveBackfill({
    bookmarks: [
      { url: youtube, eventId: 'event-youtube', savedAt: 10 },
      { url: youtubeDuplicate, eventId: 'event-youtube-duplicate', savedAt: 11 },
      { url: audio, eventId: 'event-audio', savedAt: 12 },
      { url: nonMedia, eventId: 'event-channel', savedAt: 13 },
    ],
    archives: [],
    nsecHex: '1'.repeat(64),
    pubkey: '2'.repeat(64),
  });

  const storage = await chrome.storage.local.get(null);
  const queuedKeys = Object.keys(storage).filter((key) => key.startsWith(${JSON.stringify(QUEUED_PREFIX)})).sort();
  const expectedKeys = [
    ${JSON.stringify(`${QUEUED_PREFIX}url:https://cdn.example.com/podcast/episode.mp3`)},
    ${JSON.stringify(`${QUEUED_PREFIX}yt:abcdefghi12`)},
  ];

  if (result.queued !== 2 || result.skipped !== 0) {
    throw new Error('unexpected queue result ' + JSON.stringify(result));
  }
  if (JSON.stringify(queuedKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error('unexpected queued keys ' + JSON.stringify(queuedKeys));
  }
  if (globalThis.__deepmarksSmoke.archiveCalls.length !== 2) {
    throw new Error('expected two media archive enqueue calls');
  }
  if (globalThis.__deepmarksSmoke.publishedKeys.length !== 2 || globalThis.__deepmarksSmoke.stashedKeys.length !== 2) {
    throw new Error('archive keys were not stashed and published');
  }
  if (globalThis.__deepmarksSmoke.reconcileScheduled !== 2) {
    throw new Error('archive key reconcile was not scheduled for both jobs');
  }

  return {
    queued: result.queued,
    skipped: result.skipped,
    queuedKeys,
    archiveCalls: globalThis.__deepmarksSmoke.archiveCalls.map((call) => ({
      url: call.url,
      eventId: call.eventId,
      bookmarkSavedAt: call.bookmarkSavedAt,
    })),
  };
}

run()
  .then((result) => {
    globalThis.__dmSmokeResult = result;
    globalThis.__dmSmokeDone = true;
  })
  .catch((err) => {
    globalThis.__dmSmokeError = err instanceof Error ? err.stack || err.message : String(err);
    globalThis.__dmSmokeDone = true;
  });
`);

  await writeFile(join(extensionDir, 'smoke.html'), '<!doctype html><meta charset="utf-8"><title>Deepmarks smoke</title><script type="module" src="./smoke.js"></script>\n');
  await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [{
      name: 'deepmarks-media-smoke-mocks',
      resolveId(source, importer) {
        const importerPath = importer ? importer.replaceAll('\\', '/') : '';
        if (!importerPath.endsWith('/src/lib/media-archive.ts')) return null;
        if (source === './archive.js') return mockArchive;
        if (source === './archive-keys.js') return mockArchiveKeys;
        if (source === './archive-key-reconciler.js') return mockReconciler;
        return null;
      },
    }],
    resolve: {
      alias: [
        { find: './archive.js', replacement: mockArchive },
        { find: './archive-keys.js', replacement: mockArchiveKeys },
        { find: './archive-key-reconciler.js', replacement: mockReconciler },
        { find: /\/src\/lib\/archive\.(?:js|ts)(?:$|\?)/, replacement: mockArchive },
        { find: /\/src\/lib\/archive-keys\.(?:js|ts)(?:$|\?)/, replacement: mockArchiveKeys },
        { find: /\/src\/lib\/archive-key-reconciler\.(?:js|ts)(?:$|\?)/, replacement: mockReconciler },
      ],
    },
    build: {
      outDir: extensionDir,
      emptyOutDir: false,
      rollupOptions: {
        input: entry,
        output: {
          entryFileNames: 'smoke.js',
          chunkFileNames: 'smoke-[name].js',
          assetFileNames: 'smoke-[name][extname]',
        },
      },
    },
  });

  try {
    const result = await runWithSmokeManifest(chrome, work, extensionDir);
    console.log(`PASS: Chromium media archive smoke queued ${result.queued} media archives.`);
  } finally {
    if (process.env.DEEPMARKS_KEEP_EXTENSION_SMOKE !== '1') {
      await rm(work, { recursive: true, force: true });
    } else {
      console.log(`kept smoke workspace: ${work}`);
    }
  }
}

async function runWithSmokeManifest(chrome, work, extensionDir) {
  let lastError;
  for (const manifestVersion of [3, 2]) {
    const profileDir = join(work, `profile-mv${manifestVersion}`);
    await mkdir(profileDir, { recursive: true });
    await writeSmokeManifest(extensionDir, manifestVersion);
    let browser;
    try {
      browser = await launchChrome(chrome, profileDir, extensionDir);
      const id = extensionIdFromPath(extensionDir);
      return await runSmokePage(browser.port, `chrome-extension://${id}/smoke.html`);
    } catch (err) {
      lastError = err;
      if (manifestVersion === 3) continue;
      throw err;
    } finally {
      if (browser) await stopChrome(browser.process);
    }
  }
  throw lastError;
}

function extensionIdFromPath(extensionDir) {
  const hash = createHash('sha256').update(resolve(extensionDir)).digest();
  let id = '';
  for (const byte of hash.subarray(0, 16)) {
    id += String.fromCharCode(97 + (byte >> 4));
    id += String.fromCharCode(97 + (byte & 15));
  }
  return id;
}

async function writeSmokeManifest(extensionDir, manifestVersion) {
  await writeFile(join(extensionDir, 'smoke-background.js'), 'export {};\n');
  const manifest = manifestVersion === 3
    ? {
        manifest_version: 3,
        name: 'Deepmarks Smoke',
        version: '0.0.0',
        permissions: ['storage'],
        background: { service_worker: 'smoke-background.js', type: 'module' },
        web_accessible_resources: [{
          resources: ['smoke.html', 'smoke.js'],
          matches: ['<all_urls>'],
        }],
      }
    : {
        manifest_version: 2,
        name: 'Deepmarks Smoke',
        version: '0.0.0',
        permissions: ['storage'],
        background: { scripts: ['smoke-background.js'], persistent: false },
        web_accessible_resources: ['smoke.html', 'smoke.js'],
      };
  await writeFile(join(extensionDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

function findChrome() {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const found = spawnSync('command', ['-v', bin], { shell: true, encoding: 'utf8' }).stdout.trim();
    if (found) return found;
  }
  return null;
}

async function launchChrome(chrome, profileDir, extensionDir) {
  const port = process.env.DEEPMARKS_EXTENSION_SMOKE_CDP_PORT
    ? Number(process.env.DEEPMARKS_EXTENSION_SMOKE_CDP_PORT)
    : await getFreePort();
  let stderr = '';
  const args = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--enable-extensions',
    '--disable-component-extensions-with-background-pages',
    '--disable-extensions-file-access-check',
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
  ];
  if (process.env.DEEPMARKS_EXTENSION_SMOKE_HEADLESS !== '0') args.push('--headless=new');
  if (process.platform === 'linux') args.push('--no-sandbox', '--disable-gpu');

  const child = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return { process: child, port };
    } catch {
      // keep polling until Chrome opens the debugging port
    }
    if (child.exitCode !== null) {
      throw new Error(`Chrome exited early with code ${child.exitCode}\n${stderr.trim()}`);
    }
    await delay(100);
  }
  throw new Error(`Chrome did not expose a DevTools port on ${port}\n${stderr.trim()}`);
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function runSmokePage(port, url) {
  const target = await putJson(port, '/json/new?about:blank');
  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  try {
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Page.navigate', { url });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const out = await client.send('Runtime.evaluate', {
        expression: 'globalThis.__dmSmokeDone ? ({ result: globalThis.__dmSmokeResult, error: globalThis.__dmSmokeError || null }) : null',
        returnByValue: true,
      });
      const value = out.result?.value;
      if (value) {
        if (value.error) throw new Error(value.error);
        return value.result;
      }
      await delay(250);
    }
    const diagnostic = await client.send('Runtime.evaluate', {
      expression: '({ href: location.href, readyState: document.readyState, body: document.body?.innerText || "", done: globalThis.__dmSmokeDone, error: globalThis.__dmSmokeError })',
      returnByValue: true,
    }).catch(() => null);
    throw new Error(`smoke page timed out\n${JSON.stringify({
      page: diagnostic?.result?.value,
      events: client.events.slice(-10),
    }, null, 2)}`);
  } finally {
    client.close();
  }
}

async function getJson(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return res.json();
}

async function putJson(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'PUT' });
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return res.json();
}

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (!msg.id && (msg.method === 'Runtime.consoleAPICalled' || msg.method === 'Runtime.exceptionThrown')) {
        this.events.push({
          method: msg.method,
          params: msg.method === 'Runtime.consoleAPICalled'
            ? msg.params?.args?.map((arg) => arg.value ?? arg.description).join(' ')
            : msg.params?.exceptionDetails?.text ?? msg.params?.exceptionDetails?.exception?.description,
        });
        return;
      }
      if (!msg.id) return;
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else pending.resolve(msg.result);
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    return new CdpClient(ws);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, 5_000).unref();
    });
  }

  close() {
    this.ws.close();
  }
}

async function stopChrome(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && child.exitCode === null) await delay(100);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
