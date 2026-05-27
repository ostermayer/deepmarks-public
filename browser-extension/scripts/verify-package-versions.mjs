import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const expected = String(pkg.version ?? '');

function assertStoreVersion(version) {
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) {
    throw new Error(`Chrome/Firefox manifest version must be dot-separated integers, got ${version}`);
  }
}

function readZipManifest(zipPath) {
  const raw = execFileSync('unzip', ['-p', zipPath, 'manifest.json'], { encoding: 'utf8' });
  return JSON.parse(raw);
}

function verifyTarget(target) {
  const codeManifestPath = join(root, target, 'code', 'manifest.json');
  const zipPath = join(root, target, `deepmarks-${target}.zip`);
  const codeManifest = JSON.parse(readFileSync(codeManifestPath, 'utf8'));
  const zipManifest = readZipManifest(zipPath);

  for (const [label, version] of [
    [`${target}/code/manifest.json`, codeManifest.version],
    [`${target}/deepmarks-${target}.zip`, zipManifest.version],
  ]) {
    if (version !== expected) {
      throw new Error(`${label} version ${version} does not match package.json ${expected}`);
    }
    assertStoreVersion(version);
  }

  return zipManifest.version;
}

const chromeVersion = verifyTarget('chrome');
const firefoxVersion = verifyTarget('firefox');
if (chromeVersion !== firefoxVersion) {
  throw new Error(`Chrome ${chromeVersion} and Firefox ${firefoxVersion} package versions differ`);
}

console.log(`Chrome and Firefox packages are synced at ${expected}`);
