import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const expected = String(pkg.version ?? '');

function assertStoreVersion(version) {
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) {
    throw new Error(`Extension manifest version must be dot-separated integers, got ${version}`);
  }
}

function assertSafariVersion(version, label) {
  if (version !== expected) {
    throw new Error(`${label} version ${version} does not match package.json ${expected}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`${label} must be x.y.z for App Store submission, got ${version}`);
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

const safariManifestPath = join(root, 'safari', 'Deepmarks', 'Shared (Extension)', 'Resources', 'manifest.json');
const safariManifest = JSON.parse(readFileSync(safariManifestPath, 'utf8'));
assertSafariVersion(safariManifest.version, 'safari/Deepmarks/Shared (Extension)/Resources/manifest.json');

const safariProjectPath = join(root, 'safari', 'Deepmarks', 'Deepmarks.xcodeproj', 'project.pbxproj');
const safariProject = readFileSync(safariProjectPath, 'utf8');
const marketingVersions = [...safariProject.matchAll(/\bMARKETING_VERSION = ([^;]+);/g)].map((m) => m[1]);
const buildVersions = [...safariProject.matchAll(/\bCURRENT_PROJECT_VERSION = ([^;]+);/g)].map((m) => m[1]);

if (marketingVersions.length === 0 || buildVersions.length === 0) {
  throw new Error('Safari Xcode project is missing MARKETING_VERSION or CURRENT_PROJECT_VERSION settings');
}

for (const version of marketingVersions) {
  assertSafariVersion(version, 'Safari Xcode MARKETING_VERSION');
}

const uniqueBuildVersions = new Set(buildVersions);
if (uniqueBuildVersions.size !== 1) {
  throw new Error(`Safari Xcode CURRENT_PROJECT_VERSION values differ: ${[...uniqueBuildVersions].join(', ')}`);
}

const [safariBuildVersion] = uniqueBuildVersions;
if (!/^\d+(?:\.\d+){0,2}$/.test(safariBuildVersion)) {
  throw new Error(`Safari Xcode CURRENT_PROJECT_VERSION must be 1-3 dot-separated integers, got ${safariBuildVersion}`);
}

console.log(`Chrome, Firefox, and Safari packages are synced at ${expected}`);
