import { openPdf, toMarkdown } from '@pdfextract/core';
import { describe, expect, it } from 'vitest';

/**
 * A one-page "TeX" document: runs in fonts named like Computer Modern (CMR10 text, CMMI10 and
 * CMMI7 math italic), and rules drawn as 1×1 image masks stretched by the matrix, as some TeX
 * drivers draw fraction bars.
 */
function texPdf(
  runs: { font: 'R' | 'M' | 'm'; size: number; x: number; y: number; text: string }[],
  masks: { x: number; y: number; width: number; height: number }[],
) {
  const content = [
    ...runs.map(
      ({ font, size, x, y, text }) => `BT /${font} ${size} Tf ${x} ${y} Td (${text}) Tj ET`,
    ),
    ...masks.map(({ x, y, width, height }) => `q ${width} 0 0 ${height} ${x} ${y} cm /K Do Q`),
  ].join('\n');
  const font = (name: string) => `<< /Type /Font /Subtype /Type1 /BaseFont /${name} >>`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /R 5 0 R /M 6 0 R /m 7 0 R >> /XObject << /K 8 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    font('CMR10'),
    font('CMMI10'),
    font('CMMI7'),
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ImageMask true /BitsPerComponent 1 /Length 1 >>\nstream\n\x00\nendstream',
  ];
  let body = '%PDF-1.7\n';
  const offsets = objects.map((object, i) => {
    const offset = body.length;
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}` +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body, 'latin1'));
}

const page = () =>
  texPdf(
    [
      { font: 'R', size: 10, x: 72, y: 720, text: 'Let us consider the following sum of terms.' },
      { font: 'R', size: 10, x: 72, y: 700, text: 'where' },
      { font: 'M', size: 10, x: 102, y: 700, text: 'x' },
      { font: 'm', size: 7, x: 107.5, y: 698, text: 'i' },
      { font: 'R', size: 10, x: 115, y: 700, text: 'is positive and' },
      // 1 over n: a numerator above a 0.4 pt bar drawn as an image mask, a denominator below.
      { font: 'R', size: 10, x: 190, y: 704, text: '1' },
      { font: 'M', size: 10, x: 190, y: 692, text: 'n' },
      { font: 'R', size: 10, x: 205, y: 700, text: 'is small.' },
    ],
    [{ x: 189, y: 699.8, width: 7.6, height: 0.4 }],
  );

describe('math', () => {
  it('MATH-09: math latex writes TeX formulas as LaTeX, text around them stays', async () => {
    const pdf = await openPdf(page());
    try {
      const plain = await pdf.getStructuredText();
      expect(plain.fullText).not.toContain('$');
      const latex = await pdf.getStructuredText({ math: 'latex' });
      const text = latex.pages[0].fullText;
      expect(text).toContain('where $x_{i}$ is positive and $\\frac{1}{n}$ is small.');
      expect(latex.pages[0].tables).toEqual([]);
      expect(toMarkdown(latex)).toContain('$\\frac{1}{n}$');
      // The image-mask bar is a rule for math only: table detection never sees it.
      expect(plain.pages[0].tables).toEqual([]);
    } finally {
      await pdf.close();
    }
  });
  it('MATH-10: an invalid math mode is rejected', async () => {
    const pdf = await openPdf(page());
    try {
      await expect(
        pdf.getStructuredText({ math: 'mathml' as unknown as 'latex' }),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    } finally {
      await pdf.close();
    }
  });
});
