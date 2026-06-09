// One-shot migration: move colocated *.test.ts files into /tests/<package>/...
// and rewrite relative import/mock specifiers to alias-rooted ones so the
// moved tests still resolve modules that stay behind in <package>/src.
//
//   frontend:           ./foo  ->  $lib/foo   (or $src/foo outside src/lib)
//   payment-proxy:      ./foo  ->  @src/foo
//   archive-worker:     ./foo  ->  @src/foo
//   browser-extension:  ./foo  ->  @src/foo
//
// Safe to delete after the migration has been committed.

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const PACKAGES = ['frontend', 'payment-proxy', 'archive-worker', 'browser-extension'];

const exists = (p) =>
  ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js']
    .some((ext) => fs.existsSync(p + ext)) ||
  (p.endsWith('.js') && fs.existsSync(p.slice(0, -3) + '.ts')) ||
  (p.endsWith('.js') && fs.existsSync(p.slice(0, -3) + '.tsx'));

const moves = [];
for (const pkg of PACKAGES) {
  const srcRoot = path.join(ROOT, pkg, 'src');
  const stack = [srcRoot];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) {
        if (name !== 'node_modules') stack.push(full);
      } else if (/\.test\.tsx?$/.test(name)) {
        const relUnderSrc = path.relative(srcRoot, full);
        moves.push({ pkg, from: full, to: path.join(ROOT, 'tests', pkg, relUnderSrc) });
      }
    }
  }
}

const movedSet = new Set(moves.map((m) => m.from.replace(/\.tsx?$/, '')));

for (const { pkg, from, to } of moves) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  execSync(`git mv ${JSON.stringify(path.relative(ROOT, from))} ${JSON.stringify(path.relative(ROOT, to))}`, { cwd: ROOT });

  const origDir = path.dirname(from);
  const srcRoot = path.join(ROOT, pkg, 'src');
  let content = fs.readFileSync(to, 'utf8');

  content = content.replace(/(['"])(\.\.?\/[^'"]*)\1/g, (match, quote, spec) => {
    const resolved = path.normalize(path.join(origDir, spec));
    if (!resolved.startsWith(srcRoot + path.sep) && resolved !== srcRoot) return match;
    if (!exists(resolved)) return match;
    // Target is itself a moved test file -> point at its new home in /tests.
    if (movedSet.has(resolved.replace(/\.tsx?$/, '').replace(/\.js$/, ''))) {
      const relUnderSrc = path.relative(srcRoot, resolved);
      const newTarget = path.join(ROOT, 'tests', pkg, relUnderSrc);
      let rel = path.relative(path.dirname(to), newTarget);
      if (!rel.startsWith('.')) rel = './' + rel;
      return `${quote}${rel}${quote}`;
    }
    const rel = path.relative(srcRoot, resolved);
    const alias =
      pkg === 'frontend'
        ? rel.startsWith('lib/') || rel === 'lib'
          ? '$lib/' + rel.slice(4)
          : '$src/' + rel
        : '@src/' + rel;
    return `${quote}${alias}${quote}`;
  });

  fs.writeFileSync(to, content);
}

console.log(`moved ${moves.length} test files`);
