import { type OcrProvider, openPdf } from '@pdfextract/core';
import { describe, expect, it } from 'vitest';
import { TestPdf } from '../helpers/pdf.js';

// Recognizes one word wherever it is asked.
const scanner: OcrProvider = {
  async recognize() {
    const bbox = { x: 10, y: 10, width: 60, height: 12 };
    return {
      text: 'Scanned',
      lines: [
        {
          text: 'Scanned',
          bbox,
          confidence: 90,
          words: [{ text: 'Scanned', bbox, confidence: 90 }],
        },
      ],
      warnings: [],
    };
  },
  async close() {},
};

describe('text pipeline', () => {
  it('PIPE-01: with errorMode collect, OCR still covers a page whose native text failed', async () => {
    // An ExtGState that is not a dictionary makes native text extraction fail.
    const doc = new TestPdf();
    doc.page('BT /F 10 Tf /G gs 50 700 Td (Hello) Tj ET', { resources: '/ExtGState << /G 42 >>' });
    const pdf = await openPdf(doc.build(), { ocr: scanner });
    try {
      const text = await pdf.getStructuredText({ ocr: 'always', errorMode: 'collect' });
      const [page] = text.pages;
      expect(page.warnings.map((w) => w.code)).toEqual(['TEXT_EXTRACTION_FAILED']);
      expect([page.ocrStatus, page.fullText, text.status]).toEqual([
        'performed',
        'Scanned',
        'partial',
      ]);
      // The default errorMode still fails the operation.
      await expect(pdf.getStructuredText({ ocr: 'always' })).rejects.toMatchObject({
        code: 'TEXT_EXTRACTION_FAILED',
      });
    } finally {
      await pdf.close();
    }
  });
});
