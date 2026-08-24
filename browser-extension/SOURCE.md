# Deepmarks browser extension — source code

This archive contains the complete source for `deepmarks-firefox.zip` v2.2.9.
Following the instructions below produces a byte-identical XPI.

The same source also produces the Chrome zip via `npm run build:chrome` —
the `BROWSER` environment variable picks the per-store manifest at build
time (see `manifest.config.ts`).

---

## Operating system and build environment

The build is platform-independent. Tested on:

- macOS 14 / 15 (Apple Silicon and Intel)
- Linux (Ubuntu 22.04+)
- Windows 10/11 with WSL2 (Ubuntu)

No native modules; no Docker required.

## Required programs

| Program  | Required version | Purpose                                                |
|----------|------------------|--------------------------------------------------------|
| Node.js  | 20.x or later    | Vite, the bundler, and the build scripts run on Node. |
| npm      | 10.x or later    | Dependency installation. Ships with Node 20.          |
| zip      | any              | Final packaging step (preinstalled on macOS / Linux). |

### Installing Node + npm

- **macOS** (Homebrew): `brew install node@20`
- **Linux** (Debian/Ubuntu): `curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash - && sudo apt install -y nodejs`
- **Windows** (WSL2 Ubuntu): same as Linux above
- **Cross-platform**: download from <https://nodejs.org/> (LTS channel)

Verify:
```
node --version   # v20.x.x or higher
npm  --version   # 10.x.x or higher
```

---

## Step-by-step build instructions

From the directory containing this `SOURCE.md`:

```sh
# 1. Install dependencies (locked versions in package-lock.json)
npm ci

# 2. Run the Firefox build (sets BROWSER=firefox; emits dist/)
npm run build:firefox

# 3. Package the dist directory into the XPI/zip Mozilla received
cd dist && zip -r ../deepmarks-firefox.zip . && cd ..
```

The resulting `deepmarks-firefox.zip` should match the file uploaded to AMO.

Equivalently, run the bundled script:

```sh
./build.sh
```

`build.sh` runs the same three commands.

---

## What the build does

1. **`npm ci`** — installs the exact dependency tree from `package-lock.json` into `node_modules/`.
2. **`npm run build:firefox`** — sets `BROWSER=firefox` and runs `tsc -b && vite build`:
   - `tsc -b` typechecks the TypeScript sources (no emit; emit is via Vite).
   - `vite build` invokes the `@crxjs/vite-plugin` plugin, which:
     - Reads `manifest.config.ts` and emits a Firefox-flavored `manifest.json` (background.scripts + browser_specific_settings.gecko present; service_worker absent).
     - Bundles `src/popup/index.html` and its TSX entry into `dist/assets/` chunks.
     - Bundles the background service script and content scripts.
     - Copies static `public/` assets into `dist/`.
   - Output is written to `dist/`.
3. **`zip -r`** — packages `dist/` into the final XPI shape Firefox loads. The zip file's directory layout matches `dist/` exactly.

No transpilation step happens before this build runs. Source files in `src/` are committed verbatim — TypeScript/TSX/CSS — and only become JavaScript inside `dist/` during the build.

---

## Source layout

```
browser-extension/
├── SOURCE.md                — this file
├── build.sh                 — the one-shot build script
├── package.json             — declared dependencies
├── package-lock.json        — locked transitive dependency tree
├── tsconfig.json            — TypeScript config
├── vite.config.ts           — Vite config (loads @crxjs/vite-plugin)
├── manifest.config.ts       — extension manifest (per-browser variants)
├── public/                  — static assets copied into dist/ verbatim
│   ├── pennant.svg
│   └── icons/               — 16/32/48/128 PNG toolbar icons
└── src/
    ├── background/          — MV3 background service script (entry: index.ts)
    ├── content-scripts/
    │   ├── nip07-provider.ts  — MAIN-world: defines window.nostr and window.deepmarks.nostr
    │   ├── nip07-bridge.ts    — ISOLATED-world: forwards postMessage to background
    │   └── scrape.ts          — injected on user-click to read page metadata
    ├── popup/               — React popup UI (entry: index.html → index.tsx)
    ├── lib/                 — shared utilities (crypto, nsec store, networking)
    └── types/               — TypeScript type declarations
```

## Third-party dependencies

All third-party libraries are installed via `npm ci` from `package-lock.json`.
Notable runtime dependencies (full list in `package.json`):

- `react` / `react-dom` — popup UI framework
- `nostr-tools` — Nostr event signing/encoding
- `@noble/hashes` — pure-JS crypto primitives (SHA-256, PBKDF2, etc.)
- `light-bolt11-decoder` — Lightning invoice parsing
- `qrcode` — QR rendering for NWC pairing

Build-time dependencies:

- `vite` + `@crxjs/vite-plugin` — bundler
- `typescript` — type checker (used in `tsc -b` step before Vite)

No remote code is loaded or executed at runtime — every byte that runs in
the extension is bundled into `dist/` from `src/` + `node_modules/` at
build time.
