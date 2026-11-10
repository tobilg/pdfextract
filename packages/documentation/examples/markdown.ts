import { openPdf, type PdfInput, toMarkdown } from '@pdfextract/core';

/**
 * Markdown of a whole PDF for a model or a search index: formulas as LaTeX, running headers
 * and footers left out, and an outline of the headings found.
 */
export async function markdownOf(input: PdfInput) {
  const pdf = await openPdf(input);
  try {
    const text = await pdf.getStructuredText({ ocr: 'off', math: 'latex' });
    const outline = text.pages.flatMap((page) =>
      page.blocks.flatMap((block) =>
        block.headingLevel
          ? [`${'  '.repeat(block.headingLevel - 1)}- ${block.text.replace(/\s+/g, ' ')}`]
          : [],
      ),
    );
    return { markdown: toMarkdown(text, { furniture: false }), outline: outline.join('\n') };
  } finally {
    await pdf.close();
  }
}
