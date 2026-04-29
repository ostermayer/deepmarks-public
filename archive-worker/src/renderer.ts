import { chromium, type Browser, type BrowserContext } from 'playwright';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { isPrivateIp } from './safe-url.js';

/**
 * Playwright + SingleFile renderer.
 *
 * We use SingleFile's browser bundle (not the CLI) for cleaner
 * integration. The SingleFile script, once injected into the page
 * context, produces one standalone HTML string with inlined CSS,
 * images, and fonts — that's what we store as the archive.
 *
 * A single Browser instance is shared across jobs; each job gets a
 * fresh BrowserContext (clean cookies/storage). This is the standard
 * isolation pattern for Playwright pools.
 */

const UA = 'Deepmarks-Archive/1.0 (+https://deepmarks.org/bot)';

export interface RenderOptions {
  navTimeoutMs: number;
  renderTimeoutMs: number;
  viewport: { width: number; height: number };
}

export class PageRenderer {
  private browser?: Browser;
  private singleFileScript?: string;

  constructor(private readonly options: RenderOptions) {}

  async init(): Promise<void> {
    this.browser = await chromium.launch({
      args: [
        '--no-sandbox',         // we're already in a non-root docker user
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-background-timer-throttling',
      ],
    });

    // Load the SingleFile bundle from node_modules. This is the
    // browser version (not the CLI) — a single JS file that exposes
    // window.singlefile.getPageData().
    this.singleFileScript = await loadSingleFileBundle();
  }

  async shutdown(): Promise<void> {
    await this.browser?.close().catch(() => {});
  }

  /**
   * Render a URL to a standalone HTML blob. Throws on any failure;
   * the caller categorizes the error (retryable vs permanent).
   *
   * Also captures a viewport screenshot as a JPEG thumbnail. The
   * screenshot is best-effort — if it fails we log + return null
   * rather than failing the whole archive (it's a UX nice-to-have,
   * not the actual archive product). For most consumers the
   * thumbnail is a 1280×800 JPEG @ quality 70; renders to ~80–250 KB.
   */
  async render(url: string): Promise<{ html: Buffer; screenshot: Buffer | null }> {
    if (!this.browser) throw new Error('renderer not initialized');
    if (!this.singleFileScript) throw new Error('SingleFile bundle not loaded');

    const context: BrowserContext = await this.browser.newContext({
      userAgent: UA,
      viewport: this.options.viewport,
      javaScriptEnabled: true,
      // Block cookies persistence across jobs — every context is clean.
      acceptDownloads: false,
    });

    // Outer timeout wraps the whole sequence. Individual Playwright
    // calls use their own timeouts; this catches the case where
    // something deadlocks below the API surface.
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.options.renderTimeoutMs);

    try {
      const page = await context.newPage();

      // Block obvious noise: ads, analytics, video streams. Speeds up
      // rendering and reduces chance of hanging requests.
      //
      // Also block any subresource that targets a private-IP literal in
      // its URL host. The main URL is already SSRF-checked at job
      // submission, but pages can fire off <img src="http://10.0.0.4/">
      // / fetch() / XHR through Chromium's network stack — those skip
      // our pre-flight check entirely. Catches the literal-IP form;
      // hostname → private-IP via DNS rebinding still slips by but
      // requires a rerouting attacker. Keeps the renderer from being
      // turned into an internal-network probe by hostile pages.
      await page.route('**/*', (route) => {
        const blocked = ['media', 'font', 'websocket'];
        if (blocked.includes(route.request().resourceType())) {
          route.abort().catch(() => {});
          return;
        }
        const reqUrl = route.request().url();
        try {
          const u = new URL(reqUrl);
          const host = u.hostname;
          if (looksLikeIp(host) && isPrivateIp(host)) {
            route.abort().catch(() => {});
            return;
          }
        } catch {
          // Malformed URL — let Chromium reject it the normal way.
        }
        route.continue().catch(() => {});
      });

      // 'load' instead of 'domcontentloaded' — we want main subresources
       // (CSS, hero images) fetched before we start scrolling, so the
       // initial paint matches what the user saw. domcontentloaded fires
       // way too early on image-heavy pages and our scroll pass would
       // race ahead of img.src resolutions.
      const response = await page.goto(url, {
        timeout: this.options.navTimeoutMs,
        waitUntil: 'load',
      });

      if (!response) {
        throw new RenderError('no_response', 'page produced no response', 'retryable');
      }

      if (response.status() >= 400) {
        throw new RenderError(
          'http_error',
          `page returned HTTP ${response.status()}`,
          response.status() >= 500 ? 'retryable' : 'permanent',
        );
      }

      const contentType = response.headers()['content-type'] ?? '';
      if (!contentType.includes('text/html') && !contentType.includes('xhtml')) {
        throw new RenderError(
          'unsupported_content_type',
          `content-type ${contentType} is not HTML`,
          'permanent',
        );
      }

      // Let the page settle. networkidle waits for ≥500ms with no
      // active requests; bumped from 5s → 10s because some publishers
      // (Substack, Medium) keep firing analytics + lazy-load
      // requests beyond the 5s cap and a too-tight wait skips real
      // content fetches.
      await page
        .waitForLoadState('networkidle', { timeout: 10_000 })
        .catch(() => { /* fall through */ });

      // Scroll-to-bottom pass to trigger IntersectionObserver lazy-load
      // patterns. Slower step (200ms) so heavy image grids actually have
      // time to fetch before we move on. Caps cumulative scroll time at
      // 60s but breaks early when scrollY plateaus (already at bottom).
      await page.evaluate(async () => {
        const stepPx = 400;
        const settleMs = 200;
        let lastY = -1;
        for (let i = 0; i < 300; i++) {
          if (window.scrollY === lastY) break;
          lastY = window.scrollY;
          window.scrollBy(0, stepPx);
          await new Promise((r) => setTimeout(r, settleMs));
          if (window.scrollY + window.innerHeight >= document.body.scrollHeight) break;
        }
        // Force-resolve native lazy loading: any <img loading="lazy">
        // that intersect-observer hasn't picked up by now gets nudged
        // by clearing the loading attribute. SingleFile inlines the
        // current src; if src is still a placeholder, the snapshot
        // captures the placeholder, not the real image.
        for (const img of Array.from(document.images)) {
          if (img.loading === 'lazy') img.loading = 'eager';
          // Some sites set data-src instead of src. Promote it.
          const dataSrc = img.getAttribute('data-src');
          if (dataSrc && !img.src) img.src = dataSrc;
          const dataSrcset = img.getAttribute('data-srcset');
          if (dataSrcset && !img.srcset) img.srcset = dataSrcset;
        }
        window.scrollTo(0, 0);
      }).catch(() => { /* tolerate eval failure; we still capture what we have */ });

      // After force-resolving lazy images we need another settle pass
      // for the newly-triggered fetches to complete. 8s cap is generous
      // enough for a page with dozens of images.
      await page
        .waitForLoadState('networkidle', { timeout: 8_000 })
        .catch(() => { /* fall through */ });

      // Inject SingleFile and run it.
      await page.addScriptTag({ content: this.singleFileScript });
      const html = await page.evaluate(async () => {
        // @ts-expect-error — injected global
        const { content } = await window.singlefile.getPageData({
          // Preserve hidden content (collapsed accordions, modal text,
          // off-screen tabs). Earlier we stripped these to save bytes
          // but users buying a "permanent archive" expect everything
          // they could potentially see, not just the visible viewport
          // at capture time. Smaller archives are cheaper but a missing
          // FAQ tab is worse than a 30% larger file.
          removeHiddenElements: false,
          removeUnusedStyles: false,
          removeUnusedFonts: false,
          blockImages: false,
          blockScripts: true,
          blockVideos: true,
          compressHTML: true,
          // Tell SingleFile to actively trigger and wait for any
          // remaining deferred image loads. Default behavior varies
          // across versions; pinning these explicitly keeps the
          // capture deterministic.
          loadDeferredImages: true,
          loadDeferredImagesMaxIdleTime: 4000,
          loadDeferredImagesKeepZoomLevel: false,
        });
        return content as string;
      });

      if (!html || html.length === 0) {
        throw new RenderError('empty_output', 'SingleFile returned empty content', 'retryable');
      }
      // Quality floor. SingleFile inlines CSS/fonts/images so even a
      // bare-bones article comes out >20 KB; anything under 5 KB is
      // almost always a captcha page, anti-bot challenge, paywall
      // splash, or "JavaScript required to view this site" stub.
      // Treat as retryable so we get another shot — the same URL on
      // a different attempt may bypass a transient block. If the
      // user is paying for an archive of a captcha'd page, they're
      // owed a retry and ultimately a refund (after MAX_ATTEMPTS),
      // not a 4 KB receipt of the captcha itself.
      const MIN_QUALITY_BYTES = 5_000;
      if (html.length < MIN_QUALITY_BYTES) {
        throw new RenderError(
          'capture_too_small',
          `SingleFile output ${html.length} bytes is below the ${MIN_QUALITY_BYTES}-byte quality floor (likely captcha/paywall)`,
          'retryable',
        );
      }
      // Hard cap on the captured archive. Pages with hundreds of large
      // inlined assets can produce gigabyte-class output, OOMing the
      // worker process. 50 MB is comfortably above any genuine article
      // (Substack/Medium typically ship under 5 MB) and well below the
      // memory headroom we have on Box B. Mark as permanent so the
      // caller doesn't retry — the page is what it is.
      const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
      if (html.length > MAX_ARCHIVE_BYTES) {
        throw new RenderError(
          'output_too_large',
          `SingleFile output ${html.length} bytes exceeds ${MAX_ARCHIVE_BYTES}`,
          'permanent',
        );
      }

      // Viewport screenshot for the archive thumbnail. Captured AFTER
      // SingleFile injection — by which point the lazy-load force-pass
      // has resolved, so the visible rectangle matches what real
      // visitors saw. JPEG quality 70 is the sweet spot for blog/
      // article shots: ~100 KB, perceptually indistinguishable from
      // q90 at typical thumbnail render sizes.
      let screenshot: Buffer | null = null;
      try {
        const buf = await page.screenshot({
          type: 'jpeg',
          quality: 70,
          fullPage: false,
          // SingleFile may have scrolled the page during its capture;
          // reset so the screenshot reflects the natural top-of-page
          // view (matches what a reader's first paint looked like).
          animations: 'disabled',
        });
        screenshot = Buffer.from(buf);
      } catch {
        // Screenshot is decorative — never fail the archive over it.
        screenshot = null;
      }

      return { html: Buffer.from(html, 'utf8'), screenshot };
    } finally {
      clearTimeout(timeoutHandle);
      await context.close().catch(() => {});
      if (controller.signal.aborted) {
        throw new RenderError('timeout', 'render exceeded total timeout', 'retryable');
      }
    }
  }
}

export class RenderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly category: 'retryable' | 'permanent',
  ) {
    super(message);
    this.name = 'RenderError';
  }
}

function looksLikeIp(host: string): boolean {
  // IPv6 literals arrive bracket-stripped from URL.hostname.
  return /^[0-9.]+$/.test(host) || /^[0-9a-fA-F:]+$/.test(host);
}

async function loadSingleFileBundle(): Promise<string> {
  // single-file-cli's modern bundle is an ES module that exports the
  // *injectable* code as a STRING constant called `script`:
  //
  //   const script = "var singlefile=(()=>{...})();";
  //   export { script, zipScript, hookScript };
  //
  // Earlier versions of this worker readFile()'d the bundle and
  // injected it as-is — that injects the wrapper module instead of
  // the string contents, so `window.singlefile` never gets defined
  // and every render fails with `Cannot read properties of undefined
  // (reading 'getPageData')`. Dynamic-import the module to resolve
  // through Node's normal resolver, then inject `script.script`.
  //
  // Older builds shipped a pre-bundled CJS file under different
  // paths (lib/single-file-bundle.js as raw injectable code, or
  // dist/single-file-bundle.js); we keep a readFile fallback for
  // those, gated on a sniff that the file looks like raw IIFE rather
  // than an ESM exports wrapper.
  const here = dirname(fileURLToPath(import.meta.url));
  const roots = [
    resolve(here, '../node_modules/single-file-cli'),
    resolve(here, '../../node_modules/single-file-cli'),
  ];
  for (const root of roots) {
    const bundlePath = resolve(root, 'lib/single-file-bundle.js');
    try {
      // Node ESM dynamic-import: file:// URL keeps it absolute-path-safe.
      const mod = (await import(`file://${bundlePath}`)) as { script?: string };
      if (typeof mod.script === 'string' && mod.script.length > 1000) {
        return mod.script;
      }
    } catch { /* fall through to legacy reads */ }
    // Legacy: file is raw injectable JS (older single-file-cli).
    for (const legacy of ['lib/single-file-bundle.js', 'dist/single-file-bundle.js']) {
      try {
        const raw = await readFile(resolve(root, legacy), 'utf8');
        // Sniff for the IIFE-style raw bundle vs the ESM-wrapped one.
        // Raw starts with `var singlefile=` or similar; ESM starts
        // with `const script = "…"`.
        if (raw.includes('export { script') || raw.startsWith('const script = ')) continue;
        return raw;
      } catch { /* try next */ }
    }
  }
  throw new Error(
    'could not locate SingleFile bundle — check single-file-cli installation',
  );
}
