export const MAX_BROWSER_CAPTURE_BYTES = 5 * 1024 * 1024;

export interface BrowserCapture {
  url: string;
  title: string;
  html: string;
  htmlBase64: string;
  bytes: number;
}

export async function captureActiveTabHtml(expectedUrl?: string): Promise<BrowserCapture> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || !/^https?:/i.test(tab.url)) {
    throw new Error('browser view capture only works on http(s) pages');
  }
  if (expectedUrl && normalizeUrl(tab.url) !== normalizeUrl(expectedUrl)) {
    throw new Error('active tab changed before browser view capture');
  }
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: serializeCurrentDocument,
  });
  const data = result?.result as { url: string; title: string; html: string } | undefined;
  if (!data?.html) throw new Error('could not capture this browser view');
  const bytes = new TextEncoder().encode(data.html).byteLength;
  if (bytes > MAX_BROWSER_CAPTURE_BYTES) {
    throw new Error(`browser view capture is larger than ${Math.floor(MAX_BROWSER_CAPTURE_BYTES / 1024 / 1024)} MB`);
  }
  return {
    url: data.url || tab.url,
    title: data.title || tab.title || '',
    html: data.html,
    htmlBase64: utf8ToBase64(data.html),
    bytes,
  };
}

function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = '';
    return url.toString();
  } catch {
    return raw;
  }
}

function utf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function serializeCurrentDocument(): { url: string; title: string; html: string } {
  const clone = document.documentElement.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('script').forEach((node) => node.remove());
  clone.querySelectorAll('*').forEach((node) => {
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc') node.removeAttribute(attr.name);
    }
  });

  let head = clone.querySelector('head') as HTMLHeadElement | null;
  if (!head) {
    head = document.createElement('head');
    clone.insertBefore(head, clone.firstChild);
  }
  let base = head.querySelector('base[href]') as HTMLBaseElement | null;
  if (!base) {
    base = document.createElement('base');
    head.insertBefore(base, head.firstChild);
  }
  base.href = location.href;
  if (!head.querySelector('meta[charset]')) {
    const meta = document.createElement('meta');
    meta.setAttribute('charset', 'utf-8');
    head.insertBefore(meta, head.firstChild);
  }
  const captured = document.createComment(` captured by Deepmarks browser extension at ${new Date().toISOString()} from ${location.href} `);
  head.insertBefore(captured, head.firstChild);

  return {
    url: location.href,
    title: document.title || '',
    html: `<!doctype html>\n${clone.outerHTML}`,
  };
}
