import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // Cloudflare Pages target — fully static SPA, no SSR.
    // The frontend talks to relays + payment-proxy directly from the browser.
    adapter: adapter({
      pages: 'build',
      assets: 'build',
      fallback: 'index.html',
      precompress: false,
      strict: false
    }),
    // CSP — SvelteKit's adapter-static emits two inline <script> tags
    // (theme-bootstrap to avoid FOUC, and the per-page __sveltekit_<id>
    // boot-data block). The Cloudflare _headers CSP locks script-src
    // to 'self', which blocks both → hydration fails → blank page.
    // Setting csp.mode='auto' tells SvelteKit to compute SHA-256 hashes
    // for each inline script at build time and emit a <meta http-equiv
    // ="Content-Security-Policy"> with those exact hashes whitelisted.
    // The result is a tighter CSP than 'unsafe-inline' (only the
    // specific build-output bytes are allowed) AND it works without
    // having to maintain hash strings by hand. The directives below
    // mirror what _headers had so the meta CSP is the authoritative
    // policy for hydration; _headers can keep CSP as a defense in
    // depth or drop it to avoid duplication.
    csp: {
      mode: 'auto',
      directives: {
        'default-src': ["'self'"],
        'script-src':  ["'self'"],
        'style-src':   ["'self'", "'unsafe-inline'"],
        'img-src':     ["'self'", 'data:', 'blob:', 'https:'],
        'font-src':    ["'self'", 'data:'],
        'connect-src': ["'self'", 'https:', 'wss:'],
        'frame-ancestors': ["'none'"],
        'base-uri':    ["'self'"],
        'form-action': ["'self'"],
      },
    },
    // Emit plain <link rel="stylesheet"> / no module-preload hints
    // instead of the aggressive hover/eager preload sweep. Content
    // blockers (uBlock, Brave Shields, Safari content blockers) pattern-
    // match on the immutable/*.js preload URLs and a single failed
    // preload crashes hydration → blank page. Slightly slower first
    // paint for unblocked users; much more robust for blocked ones.
    output: {
      preloadStrategy: 'preload-mjs',
      bundleStrategy: 'split',
    },
  },
};

export default config;
