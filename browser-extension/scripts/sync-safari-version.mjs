import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = String(pkg.version ?? '');
const buildVersion = process.env.SAFARI_BUILD_NUMBER || version;
if (!process.env.SAFARI_BUILD_NUMBER) {
  // The build number is a plain integer counter (+1 per App Store
  // upload; v2.2.9 shipped as build 29), NEVER the marketing version:
  // macOS requires CFBundleVersion to increase across every upload,
  // and defaulting to the marketing version collides on resubmissions
  // (2.2.8 had to re-upload as build "2.2.9", which then blocked
  // 2.2.9 from using its own number).
  console.warn(
    'WARNING: SAFARI_BUILD_NUMBER unset — CURRENT_PROJECT_VERSION defaults '
    + 'to the marketing version. Pass the integer build counter '
    + '(see docs/release.md, "Safari marketing version vs build number").',
  );
}

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`Safari marketing version must be x.y.z, got ${version}`);
}

if (!/^\d+(?:\.\d+){0,2}$/.test(buildVersion)) {
  throw new Error(`Safari build version must be 1-3 dot-separated integers, got ${buildVersion}`);
}

const projectPath = join(root, 'safari', 'Deepmarks', 'Deepmarks.xcodeproj', 'project.pbxproj');
const original = readFileSync(projectPath, 'utf8');

let marketingCount = 0;
let buildCount = 0;
const next = original
  .replace(/\bMARKETING_VERSION = [^;]+;/g, () => {
    marketingCount += 1;
    return `MARKETING_VERSION = ${version};`;
  })
  .replace(/\bCURRENT_PROJECT_VERSION = [^;]+;/g, () => {
    buildCount += 1;
    return `CURRENT_PROJECT_VERSION = ${buildVersion};`;
  });

if (marketingCount === 0 || buildCount === 0) {
  throw new Error(`Could not find Safari version settings in ${projectPath}`);
}

if (next !== original) {
  writeFileSync(projectPath, next);
}

console.log(`Safari Xcode versions synced: ${version} (${buildVersion})`);
