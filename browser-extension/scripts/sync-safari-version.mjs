import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = String(pkg.version ?? '');
const buildVersion = process.env.SAFARI_BUILD_NUMBER || version;

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
