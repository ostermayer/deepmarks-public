import { describe, expect, it } from 'vitest';
import { detectScholarlyFullTextPdf, extractDoiFromHtml, extractPdfUrlFromHtml } from './scholarly.js';

describe('scholarly archive detection', () => {
  it('detects DOI metadata and a citation PDF URL', () => {
    const html = Buffer.from(`<html><head>
      <meta name="citation_doi" content="10.1093/biosci/biaf050" />
      <meta name="citation_pdf_url" content="/bioscience/article-pdf/doi/10.1093/biosci/biaf050/file.pdf" />
    </head></html>`);

    expect(detectScholarlyFullTextPdf('https://academic.oup.com/bioscience/article/doi/10.1093/biosci/biaf050/8116758', html))
      .toEqual({
        doi: '10.1093/biosci/biaf050',
        pdfUrl: 'https://academic.oup.com/bioscience/article-pdf/doi/10.1093/biosci/biaf050/file.pdf',
      });
  });

  it('requires DOI metadata before returning a PDF URL', () => {
    const html = '<html><body><a href="/download.pdf">PDF</a></body></html>';
    expect(extractPdfUrlFromHtml('https://example.com/post', html)).toBe('https://example.com/download.pdf');
    expect(detectScholarlyFullTextPdf('https://example.com/post', Buffer.from(html))).toBeNull();
  });

  it('extracts DOI values from common scholarly meta fields', () => {
    expect(extractDoiFromHtml('<meta name="dc.identifier" content="doi:10.1000/ABC.Def" />'))
      .toBe('10.1000/abc.def');
  });
});
