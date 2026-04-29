// Active-tab metadata reader.
//
// On the Add screen we want the URL of the page the user is looking at
// (chrome.tabs.query) and the page's <title> + og:description (via a
// throwaway content-script execution). Both are best-effort: a tab on
// chrome:// or a PDF viewer may have neither.

export interface ActiveTabInfo {
  url: string;
  title: string;
  description: string;
  /** True when title/description came from the page's <head>, not just
   *  the tab's `title` (which Chrome sets from <title> but is a slightly
   *  noisier signal — sometimes prefixed with site name, etc). */
  scraped: boolean;
}

export async function readActiveTab(): Promise<ActiveTabInfo | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !tab.id) return null;
  // chrome:// / about: / file: pages can't be scripted; skip the
  // content-script step and just return whatever the tab object has.
  if (!/^https?:/.test(tab.url)) {
    return { url: tab.url, title: tab.title ?? '', description: '', scraped: false };
  }
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrapePageHead,
    });
    const data = result?.result as { title: string; description: string } | undefined;
    return {
      url: tab.url,
      title: data?.title || tab.title || '',
      description: data?.description || '',
      scraped: !!data,
    };
  } catch {
    // Permissions or CSP blocked the script. Fall back to tab object.
    return { url: tab.url, title: tab.title ?? '', description: '', scraped: false };
  }
}

// Runs in the page's main world. Returns serializable shape.
//
// Title priority is `<title>` first, og:title / twitter:title as
// fallbacks. Earlier versions preferred og:title (cleaner for social
// shares) but publishers often put a different — sometimes shorter,
// sometimes appended-with-site-name — string in og:title than what
// the user actually sees in their browser tab. The user reported the
// autofilled title not matching what they were reading; defaulting
// to document.title makes the autofill exactly match the page title
// they saw, with the social-meta fallbacks only kicking in for SPAs
// that don't update document.title (rare in modern apps).
function scrapePageHead(): { title: string; description: string } {
  const get = (sel: string, attr: string) =>
    (document.querySelector(sel) as HTMLMetaElement | null)?.getAttribute(attr) ?? '';
  const title =
    document.title ||
    get('meta[property="og:title"]', 'content') ||
    get('meta[name="twitter:title"]', 'content') ||
    '';
  const description =
    get('meta[property="og:description"]', 'content') ||
    get('meta[name="twitter:description"]', 'content') ||
    get('meta[name="description"]', 'content') ||
    '';
  return { title: title.trim(), description: description.trim() };
}
