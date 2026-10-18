import {
  type EmbeddedImage,
  type OcrProvider,
  openPdf,
  type ProgressEvent,
} from '@pdfextract/core';
import { decode } from 'fast-png';
import { describe, expect, it } from 'vitest';
import { TestPdf } from '../helpers/pdf.js';

// Three pages: a red image on pages 1 and 3 (reused), a blue one on page 2.
function threePages() {
  const doc = new TestPdf();
  const red = doc.image(8, 4, () => [255, 0, 0]);
  const blue = doc.image(6, 6, () => [0, 0, 255]);
  doc.page('q 80 0 0 40 100 700 cm /R Do Q', { xobjects: { R: red } });
  doc.page('q 60 0 0 60 100 600 cm /B Do Q', { xobjects: { B: blue } });
  doc.page('q 0 40 -80 0 300 500 cm /R Do Q', { xobjects: { R: red } });
  return doc.build();
}
// No text: OCR here only tells which images were offered.
const silent = (seen: number[]): OcrProvider => ({
  async recognize(raster) {
    seen.push(raster.width * raster.height);
    return { text: '', lines: [], warnings: [] };
  },
  async close() {},
});
// Strips the per-document ID prefix (a UUID and a dash) for comparisons across documents.
const portable = (images: readonly EmbeddedImage[]) =>
  images.map((image) => ({
    ...image,
    id: image.id.slice(37),
    warnings: image.warnings.map((w) => ({ ...w, imageId: w.imageId?.slice(37) })),
    occurrences: image.occurrences.map((o) => ({ ...o, occurrenceId: o.occurrenceId.slice(37) })),
  }));

describe('image inventory', () => {
  it('INV-01: OCR auto scans only the selected pages; later listings match a fresh document', async () => {
    const bytes = threePages(),
      rasters: number[] = [],
      progress: ProgressEvent[] = [];
    const pdf = await openPdf(bytes, { ocr: silent(rasters) });
    try {
      await pdf.getStructuredText({
        pages: [2],
        ocr: 'auto',
        onProgress: (event) => progress.push(event),
      });
      expect(progress.filter((e) => e.stage === 'images').map((e) => e.pageNumber)).toEqual([2]);
      // Only the blue 6×6 image of page 2 was recognized.
      expect(rasters).toEqual([36]);
      const listed = await pdf.getImages();
      const fresh = await openPdf(bytes);
      try {
        expect(portable(listed)).toEqual(portable(await fresh.getImages()));
        // Exports decode from the first page drawing each image, whatever was scanned first.
        const [red] = listed;
        expect(red.occurrences.map((o) => o.pageNumber)).toEqual([1, 3]);
        const exported = await pdf.extractImage(red.id);
        expect([exported.width, exported.height]).toEqual([8, 4]);
      } finally {
        await fresh.close();
      }
    } finally {
      await pdf.close();
    }
  });
  it('INV-02: repeated and alternating exports from cached pages are byte-identical', async () => {
    const doc = new TestPdf();
    const rgb = doc.image(16, 8, (x, y) => [x * 16, y * 32, 128]);
    const masked = doc.image(
      8,
      8,
      () => [0, 200, 0],
      (x) => (x < 4 ? 64 : 255),
    );
    const stencil = doc.add(
      '<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ImageMask true /BitsPerComponent 1 >>',
      Buffer.from([0x0f, 0xf0, 0x0f, 0xf0, 0x0f, 0xf0, 0x0f, 0xf0]),
    );
    const other = doc.image(4, 4, () => [10, 20, 30]);
    doc.page(
      [
        'q 160 0 0 80 50 650 cm /A Do Q',
        'q 80 0 0 80 250 650 cm /M Do Q',
        // The stencil twice, in two colors: two images sharing one stream.
        '1 0 0 rg q 80 0 0 80 50 500 cm /S Do Q',
        '0 0 1 rg q 80 0 0 80 250 500 cm /S Do Q',
        'q 40 0 0 40 400 500 cm BI /W 2 /H 2 /CS /RGB /BPC 8 /F /AHx ID ff000000ff000000ffffffff> EI Q',
      ].join('\n'),
      { xobjects: { A: rgb, M: masked, S: stencil } },
    );
    doc.page('q 40 0 0 40 50 650 cm /O Do Q', { xobjects: { O: other } });
    const pdf = await openPdf(doc.build());
    try {
      const images = await pdf.getImages();
      expect(images.length).toBe(6);
      const exportAll = async () => {
        const out: Uint8Array[] = [];
        for (const image of images) out.push((await pdf.extractImage(image.id)).data);
        return out;
      };
      const first = await exportAll();
      expect(await exportAll()).toEqual(first);
      // An inline decode drops the worker's page cache; the page is rebuilt for the next one.
      const inline = images[4];
      expect(inline.width).toBe(2);
      for (const index of [4, 0, 4, 1])
        expect((await pdf.extractImage(images[index].id)).data).toEqual(first[index]);
      expect((await pdf.extractImage(inline.id)).data).toEqual(first[4]);
      // Alternate between the pages, with thumbnails in between.
      const [a, , , , , o] = images;
      for (let round = 0; round < 2; round++) {
        expect((await pdf.extractImage(a.id)).data).toEqual(first[0]);
        expect((await pdf.extractImage(o.id)).data).toEqual(first[5]);
        await pdf.extractImage(a.id, { maxWidth: 4 });
      }
    } finally {
      await pdf.close();
    }
  });
  it('INV-03: images progress covers every requested page on every call', async () => {
    const pdf = await openPdf(threePages(), { ocr: silent([]) });
    const pagesOf = async (
      run: (onProgress: (event: ProgressEvent) => void) => Promise<unknown>,
    ) => {
      const pages: (number | undefined)[] = [];
      await run((event) => {
        if (event.stage === 'images') pages.push(event.pageNumber);
      });
      return pages;
    };
    try {
      for (let round = 0; round < 2; round++)
        expect(
          await pagesOf((onProgress) =>
            pdf.getStructuredText({ pages: [2], ocr: 'auto', onProgress }),
          ),
        ).toEqual([2]);
      // The first listing reports the requested page and the pages it scans to complete the
      // inventory; later listings report the requested pages only.
      expect(await pagesOf((onProgress) => pdf.getImages({ pages: [3], onProgress }))).toEqual([
        1, 3,
      ]);
      expect(await pagesOf((onProgress) => pdf.getImages({ pages: [3], onProgress }))).toEqual([3]);
      for (let round = 0; round < 2; round++)
        expect(await pagesOf((onProgress) => pdf.getImages({ onProgress }))).toEqual([1, 2, 3]);
      const [image] = await pdf.getImages();
      expect(await pagesOf((onProgress) => pdf.extractImage(image.id, { onProgress }))).toEqual([]);
    } finally {
      await pdf.close();
    }
  });
  it('INV-04: alternating table and image scans of one page give stable results', async () => {
    const doc = new TestPdf();
    const image = doc.image(16, 16, (x, y) => [x * 16, y * 16, 50]);
    const cells = [
      ['Part', 'Qty', 'Price'],
      ['Bolt', '12', '0.40'],
      ['Nut', '30', '0.15'],
    ];
    doc.page(
      [
        ...[700, 680, 660, 640].map((y) => `50 ${y} m 350 ${y} l S`),
        ...[50, 150, 250, 350].map((x) => `${x} 700 m ${x} 640 l S`),
        ...cells.flatMap((row, r) =>
          row.map((cell, c) => `BT /F 10 Tf ${55 + c * 100} ${686 - r * 20} Td (${cell}) Tj ET`),
        ),
        'q 80 0 0 80 400 640 cm /I Do Q',
      ].join('\n'),
      { xobjects: { I: image } },
    );
    // A budget below the page's 8 lines keeps them uncached, so every table call scans ruling
    // lines (a lenient scan) and every export decodes (a strict one): the worker's page cache
    // switches each time.
    const pdf = await openPdf(doc.build(), { limits: { maxCachedRuleLines: 1 } });
    try {
      const [listed] = await pdf.getImages();
      const tables = (await pdf.getStructuredText()).pages[0].tables;
      expect(tables.map((t) => t.detection)).toEqual(['ruled']);
      const png = (await pdf.extractImage(listed.id)).data;
      for (let round = 0; round < 3; round++) {
        expect((await pdf.getStructuredText()).pages[0].tables).toEqual(tables);
        expect((await pdf.extractImage(listed.id)).data).toEqual(png);
      }
    } finally {
      await pdf.close();
    }
  });
  it('INV-05: a broken text operator degrades its page instead of failing the inventory', async () => {
    const doc = new TestPdf();
    const image = doc.image(40, 20, () => [255, 0, 0]);
    // Page 1 shows text before any font is set, then draws the image and a blue square on it.
    doc.page(
      'BT 40 705 Td (MMMM) Tj ET\nq 40 0 0 20 100 700 cm /I Do Q\n0 0 1 rg 130 710 5 5 re f',
      { xobjects: { I: image } },
    );
    doc.page('q 40 0 0 20 100 700 cm /I Do Q', { xobjects: { I: image } });
    const rasters: { red: number; size: number }[] = [];
    const ocr: OcrProvider = {
      async recognize(raster) {
        let red = 0;
        for (let i = 0; i < raster.data.length; i += 4)
          if (raster.data[i] > 200 && raster.data[i + 1] < 60) red++;
        rasters.push({ red, size: raster.width * raster.height });
        return { text: '', lines: [], warnings: [] };
      },
      async close() {},
    };
    const pdf = await openPdf(doc.build(), { ocr });
    try {
      const images = await pdf.getImages();
      expect(images.map((i) => i.occurrences.map((o) => o.pageNumber))).toEqual([[1, 2]]);
      expect(images.warnings.map((w) => [w.code, w.pageNumber])).toEqual([
        ['IMAGE_INVENTORY_DEGRADED', 1],
      ]);
      expect((await pdf.getImages({ pages: [2] })).warnings).toEqual([]);
      const [red] = images;
      expect((await pdf.extractImage(red.id)).composited).toBe('none');
      // The composite renders leniently: the image and the square above it, not a blank area.
      const view = await pdf.extractImage(red.id, { composite: true });
      expect(view.composited).toBe('above');
      const png = decode(view.data);
      const pixel = (x: number, y: number) =>
        Array.from(png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 4));
      expect(pixel(5, 10)).toEqual([255, 0, 0, 255]);
      expect(pixel(32, 7)).toEqual([0, 0, 255, 255]);
      // Text extraction stays strict; OCR auto reports the degraded inventory.
      const auto = await pdf.getStructuredText({ ocr: 'auto', errorMode: 'collect' });
      expect(auto.pages[0].warnings.map((w) => w.code).sort()).toEqual([
        'IMAGE_INVENTORY_DEGRADED',
        'TEXT_EXTRACTION_FAILED',
      ]);
      expect(auto.pages[1].warnings).toEqual([]);
      // Full-page OCR renders the page leniently too: the image is in the raster.
      rasters.length = 0;
      await pdf.getStructuredText({ pages: [1], ocr: 'always', errorMode: 'collect' });
      expect(rasters).toHaveLength(1);
      expect(rasters[0].red).toBeGreaterThan(100);
    } finally {
      await pdf.close();
    }
  });
});
