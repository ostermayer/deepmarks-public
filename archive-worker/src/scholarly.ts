export interface ScholarlyFullTextPdf {
  doi: string;
  pdfUrl: string;
}

/**
 * Detect scholarly articles from DOI-bearing metadata and return the
 * publisher-exposed full-text PDF URL when one is present. This is
 * intentionally metadata-led: a random blog linking a PDF should not
 * become a multi-file scholarly archive.
 */
export function detectScholarlyFullTextPdf(pageUrl: string, htmlBytes: Buffer): ScholarlyFullTextPdf | null {
  const html = htmlBytes.toString('utf8');
  const doi = extractDoiFromHtml(html);
  if (!doi) return null;
  const pdfUrl = extractPdfUrlFromHtml(pageUrl, html);
  if (!pdfUrl) return null;
  if (sameUrlIgnoringHash(pageUrl, pdfUrl)) return null;
  return { doi, pdfUrl };
}

export function extractDoiFromHtml(html: string): string | null {
  const metaNames = [
    'citation_doi',
    'dc.identifier',
    'dc.identifier.doi',
    'doi',
    'prism.doi',
    'bepress_citation_doi',
  ];
  for (const name of metaNames) {
    const value = firstMetaContent(html, name);
    const doi = normalizeDoi(value);
    if (doi) return doi;
  }
  return null;
}

export function extractPdfUrlFromHtml(pageUrl: string, html: string): string | null {
  const metaNames = [
    'citation_pdf_url',
    'bepress_citation_pdf_url',
    'eprints.document_url',
  ];
  for (const name of metaNames) {
    const value = firstMetaContent(html, name);
    const url = safeResolveHttpUrl(value, pageUrl);
    if (url) return url;
  }

  const linkPatterns = [
    /<link\b[^>]*type=["']application\/pdf["'][^>]*>/gi,
    /<a\b[^>]*(?:type=["']application\/pdf["']|href=["'][^"']+\.pdf(?:[?#][^"']*)?["']|href=["'][^"']*\/pdf(?:[/?#][^"']*)?["'])[^>]*>/gi,
  ];
  for (const pattern of linkPatterns) {
    const matches = html.matchAll(pattern);
    for (const match of matches) {
      const tag = match[0] ?? '';
      const href = attrValue(tag, 'href');
      const url = safeResolveHttpUrl(href, pageUrl);
      if (url) return url;
    }
  }
  return null;
}

function firstMetaContent(html: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta\\b(?=[^>]*(?:name|property)=["']${escaped}["'])[^>]*>`, 'i'),
    new RegExp(`<meta\\b(?=[^>]*content=["'][^"']+["'])(?=[^>]*(?:name|property)=["']${escaped}["'])[^>]*>`, 'i'),
  ];
  for (const pattern of patterns) {
    const tag = html.match(pattern)?.[0];
    if (!tag) continue;
    const content = attrValue(tag, 'content');
    if (content) return decodeEntities(content);
  }
  return null;
}

function attrValue(tag: string, attr: string): string | null {
  const escaped = attr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = tag.match(new RegExp(`\\b${escaped}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
  return match?.[2] ? decodeEntities(match[2]) : null;
}

function safeResolveHttpUrl(raw: string | null | undefined, base: string): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim(), base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeDoi(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '');
  const match = value.match(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
  return match ? match[0].replace(/[).,;:\]\s]+$/g, '').toLowerCase() : null;
}

function sameUrlIgnoringHash(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    a.hash = '';
    b.hash = '';
    return a.toString() === b.toString();
  } catch {
    return left === right;
  }
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
