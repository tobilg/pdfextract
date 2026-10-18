import { type OpenPdfOptions, openPdf } from '@pdfextract/core';
import { decode } from 'fast-png';
import { describe, expect, it } from 'vitest';
import { TestPdf } from '../helpers/pdf.js';

const RED = [255, 0, 0, 255],
  BLUE = [0, 0, 255, 255],
  GREEN = [0, 255, 0, 255];
// A 40×20 red image drawn 1:1 at x 100–140, y 700–720 (PDF space): raster x = pdfX − 100,
// raster y = 720 − pdfY.
const BASE = 'q 40 0 0 20 100 700 cm /I Do Q';
function pdf(build: (doc: TestPdf, image: number) => void) {
  const doc = new TestPdf();
  build(
    doc,
    doc.image(40, 20, () => [255, 0, 0]),
  );
  return doc.build();
}
async function open(bytes: Uint8Array, options: OpenPdfOptions = {}) {
  return openPdf(bytes, options);
}
function pixel(png: Uint8Array, x: number, y: number) {
  const image = decode(png);
  const o = (y * image.width + x) * 4;
  return Array.from(image.data.subarray(o, o + 4));
}
function near(actual: number[], expected: readonly number[], tolerance = 3) {
  expect(
    actual.every((v, i) => Math.abs(v - expected[i]) <= tolerance),
    `${actual} ≈ ${expected}`,
  ).toBe(true);
}
/** Expects the first image's first occurrence to be overlaid (or not), naming the case. */
async function expectOverlaid(name: string, bytes: Uint8Array, overlaid: boolean) {
  const doc = await open(bytes);
  try {
    const [base] = await doc.getImages();
    expect([name, base.occurrences[0].overlaid]).toEqual([name, overlaid]);
  } finally {
    await doc.close();
  }
}
// Black below the image, a blue square and a green image above it.
const layered = pdf((doc, image) => {
  const green = doc.image(2, 2, () => [0, 255, 0]);
  doc.page(
    `0 0 0 rg 90 690 60 40 re f\n${BASE}\n0 0 1 rg 110 705 10 10 re f\nq 4 0 0 4 130 702 cm /G Do Q`,
    { xobjects: { I: image, G: green } },
  );
});

describe('composite image export', () => {
  it('COMP-01: overlays are composited above the image in drawing order', async () => {
    const doc = await open(layered);
    try {
      const [base, green] = await doc.getImages();
      expect(base.occurrences[0].overlaid).toBe(true);
      expect(green.occurrences[0].overlaid).toBe(false);
      const exact = await doc.extractImage(base.id);
      expect(exact.composited).toBe('none');
      near(pixel(exact.data, 15, 10), RED, 0);
      const view = await doc.extractImage(base.id, { composite: true });
      expect([view.width, view.height, view.variant, view.composited]).toEqual([
        40,
        20,
        'full',
        'above',
      ]);
      near(pixel(view.data, 15, 10), BLUE);
      near(pixel(view.data, 31, 15), GREEN);
      near(pixel(view.data, 2, 2), RED);
      near(pixel(view.data, 38, 18), RED);
    } finally {
      await doc.close();
    }
  });
  it('COMP-02: content below a transparent image stays excluded', async () => {
    const doc = new TestPdf();
    const image = doc.image(
      40,
      20,
      () => [255, 0, 0],
      (x) => (x < 20 ? 0 : 255),
    );
    doc.page(`0 0 0 rg 90 690 60 40 re f\n${BASE}\n0 0 1 rg 130 705 5 5 re f`, {
      xobjects: { I: image },
    });
    const pdf = await open(doc.build());
    try {
      const [base] = await pdf.getImages();
      const view = await pdf.extractImage(base.id, { composite: true });
      expect(view.composited).toBe('above');
      expect(pixel(view.data, 5, 10)[3]).toBe(0);
      near(pixel(view.data, 25, 10), RED);
      near(pixel(view.data, 32, 12), BLUE);
    } finally {
      await pdf.close();
    }
  });
  it('COMP-03: visible text overlays; invisible OCR-layer text does not', async () => {
    for (const [mode, overlaid] of [
      [0, true],
      [3, false],
    ] as const) {
      const bytes = pdf((doc, image) =>
        doc.page(`${BASE}\nBT ${mode} Tr /F 14 Tf 102 704 Td (MM) Tj ET`, {
          xobjects: { I: image },
        }),
      );
      const doc = await open(bytes);
      try {
        const [base] = await doc.getImages();
        expect(base.occurrences[0].overlaid).toBe(overlaid);
        const view = await doc.extractImage(base.id, { composite: true });
        expect(view.composited).toBe(overlaid ? 'above' : 'none');
        const image = decode(view.data);
        let dark = 0;
        for (let i = 0; i < image.data.length; i += 4) if (image.data[i] < 100) dark++;
        expect(dark > 20).toBe(overlaid);
      } finally {
        await doc.close();
      }
    }
  });
  it('COMP-10: overlay detection follows clipping and stroke geometry', async () => {
    const shading =
      '/Shading << /Sh << /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 600 0] /Function << /FunctionType 2 /Domain [0 1] /C0 [1 1 0] /C1 [0 1 1] /N 1 >> >> >>';
    for (const [name, content, overlaid] of [
      ['gradient elsewhere', 'q 300 300 50 50 re W n /Sh sh Q', false],
      ['gradient over the image', 'q 110 700 10 20 re W n /Sh sh Q', true],
      ['frame around the image', '1 w 97 697 46 26 re S', false],
      ['line across the image', '1 w 90 710 m 150 710 l S', true],
      ['clipped-away text', 'q 300 300 10 10 re W n BT /F 14 Tf 102 704 Td (MM) Tj ET Q', false],
      [
        'text clipped onto the image',
        'q 100 700 40 20 re W n BT /F 14 Tf 102 704 Td (MM) Tj ET Q',
        true,
      ],
    ] as const) {
      const bytes = pdf((doc, image) =>
        doc.page(`${BASE}\n${content}`, { xobjects: { I: image }, resources: shading }),
      );
      const doc = await open(bytes);
      try {
        const [base] = await doc.getImages();
        expect([name, base.occurrences[0].overlaid]).toEqual([name, overlaid]);
      } finally {
        await doc.close();
      }
    }
  });
  it('COMP-15: clipped reports only clips that cut the image', async () => {
    const cases: [string, (doc: TestPdf, image: number) => void, boolean][] = [
      [
        'page-wide clip',
        (d, i) => d.page(`0 0 600 800 re W n\n${BASE}`, { xobjects: { I: i } }),
        false,
      ],
      [
        'full-page form XObject',
        (d, i) => {
          const form = d.add(
            `<< /Type /XObject /Subtype /Form /BBox [0 0 600 800] /Resources << /XObject << /I ${i} 0 R >> >> >>`,
            Buffer.from(BASE),
          );
          d.page('/Fm Do', { xobjects: { Fm: form } });
        },
        false,
      ],
      [
        'form BBox cutting the image',
        (d, i) => {
          const form = d.add(
            `<< /Type /XObject /Subtype /Form /BBox [0 0 120 800] /Resources << /XObject << /I ${i} 0 R >> >> >>`,
            Buffer.from(BASE),
          );
          d.page('/Fm Do', { xobjects: { Fm: form } });
        },
        true,
      ],
      [
        'clip cutting the image',
        (d, i) => d.page(`100 700 20 20 re W n\n${BASE}`, { xobjects: { I: i } }),
        true,
      ],
      [
        // A rotated rectangle containing the image is not tracked exactly: conservative.
        'rotated clip',
        (d, i) =>
          d.page(
            `q 0.9848 0.1736 -0.1736 0.9848 0 0 cm -500 -500 2000 2000 re W n 0.9848 -0.1736 0.1736 0.9848 0 0 cm\n${BASE}\nQ`,
            { xobjects: { I: i } },
          ),
        true,
      ],
      [
        'clip-mode text',
        (d, i) =>
          d.page(`q BT 7 Tr /F 40 Tf 95 695 Td (MM) Tj ET\n${BASE}\nQ`, { xobjects: { I: i } }),
        true,
      ],
    ];
    for (const [name, build, clipped] of cases) {
      const doc = await open(pdf(build));
      try {
        const [base] = await doc.getImages();
        const view = await doc.extractImage(base.id, { composite: true });
        expect([name, base.occurrences[0].clipped, view.composited]).toEqual([
          name,
          clipped,
          clipped ? 'above' : 'none',
        ]);
      } finally {
        await doc.close();
      }
    }
  });
  it('COMP-16: text extents follow Type3 font matrices and vertical writing', async () => {
    // A Type3 font in 1/100 em units: five glyphs of 10 pt text span 50 pt.
    const type3 = (doc: TestPdf) => {
      const glyph = doc.add('<< >>', Buffer.from('100 0 0 0 100 100 d1 0 0 100 100 re f'));
      return doc.add(
        `<< /Type /Font /Subtype /Type3 /FontBBox [0 0 100 100] /FontMatrix [0.01 0 0 0.01 0 0] /CharProcs << /A ${glyph} 0 R >> /Encoding << /Type /Encoding /Differences [65 /A] >> /FirstChar 65 /LastChar 65 /Widths [100] /Resources << >> >>`,
      );
    };
    // A non-embedded CID font written top to bottom (Identity-V), 1 em per glyph.
    const vertical = (doc: TestPdf) => {
      const descriptor = doc.add(
        '<< /Type /FontDescriptor /FontName /Fallback /Flags 4 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>',
      );
      const cid = doc.add(
        `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Fallback /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /DW 1000 >>`,
      );
      return doc.add(
        `<< /Type /Font /Subtype /Type0 /BaseFont /Fallback /Encoding /Identity-V /DescendantFonts [${cid} 0 R] >>`,
      );
    };
    // The image covers x 100-140, y 700-720.
    for (const [name, font, content, overlaid] of [
      ['Type3 text reaching the image', type3, 'BT /T 10 Tf 60 705 Td (AAAAA) Tj ET', true],
      ['Type3 text beside the image', type3, 'BT /T 10 Tf 10 705 Td (AAAAA) Tj ET', false],
      [
        'vertical text running down into the image',
        vertical,
        'BT /T 10 Tf 120 760 Td <0041004200430044004500460047> Tj ET',
        true,
      ],
      [
        'vertical text beside the image',
        vertical,
        'BT /T 10 Tf 200 760 Td <0041004200430044004500460047> Tj ET',
        false,
      ],
    ] as const) {
      const bytes = pdf((doc, image) =>
        doc.page(`${BASE}\n${content}`, { xobjects: { I: image }, fonts: { T: font(doc) } }),
      );
      await expectOverlaid(name, bytes, overlaid);
    }
    // The same Type3 font set through an ExtGState instead of Tf.
    for (const [name, x, overlaid] of [
      ['Type3 text via ExtGState reaching the image', 60, true],
      ['Type3 text via ExtGState beside the image', 10, false],
    ] as const) {
      const bytes = pdf((doc, image) =>
        doc.page(`${BASE}\nBT /GS gs ${x} 705 Td (AAAAA) Tj ET`, {
          xobjects: { I: image },
          resources: `/ExtGState << /GS << /Font [${type3(doc)} 0 R 10] >> >>`,
        }),
      );
      await expectOverlaid(name, bytes, overlaid);
    }
  });
  it('COMP-04: quarter-turn placements composite upright like the exact export', async () => {
    const doc = new TestPdf();
    const image = doc.image(40, 20, (x, y) => [x * 6, y * 12, 100]);
    doc.page('q 0 40 -20 0 300 600 cm /I Do Q\n0 0 1 rg 282 602 4 4 re f', {
      xobjects: { I: image },
    });
    const pdf = await open(doc.build());
    try {
      const [base] = await pdf.getImages();
      const exact = decode((await pdf.extractImage(base.id)).data);
      const view = await pdf.extractImage(base.id, { composite: true });
      expect([view.width, view.height]).toEqual([exact.width, exact.height]);
      expect([view.width, view.height]).toEqual([20, 40]);
      const rendered = decode(view.data);
      let different = 0;
      for (let i = 0; i < exact.data.length; i += 4)
        if ([0, 1, 2, 3].some((k) => Math.abs(exact.data[i + k] - rendered.data[i + k]) > 3))
          different++;
      // Only the 4×4 overlay (plus antialiased edges) differs.
      expect(different).toBeGreaterThanOrEqual(16);
      expect(different).toBeLessThanOrEqual(36);
    } finally {
      await pdf.close();
    }
  });
  it('COMP-11: a scale other than 1 renders even without overlays', async () => {
    const doc = await open(pdf((d, image) => d.page(BASE, { xobjects: { I: image } })));
    try {
      const [base] = await doc.getImages();
      expect(base.occurrences[0].overlaid).toBe(false);
      const exact = await doc.extractImage(base.id, { composite: true });
      expect([exact.width, exact.height, exact.composited]).toEqual([40, 20, 'none']);
      const scaled = await doc.extractImage(base.id, { composite: true, scale: 2 });
      expect([scaled.width, scaled.height, scaled.composited]).toEqual([80, 40, 'above']);
      near(pixel(scaled.data, 40, 20), RED);
      // Fractional factors are valid; sizes round to whole pixels.
      const fractional = await doc.extractImage(base.id, { composite: true, scale: 1.5 });
      expect([fractional.width, fractional.height]).toEqual([60, 30]);
    } finally {
      await doc.close();
    }
  });
  it('COMP-12: same-position draws of different rasters each composite at their own draw', async () => {
    const doc = new TestPdf();
    const red = doc.image(40, 20, () => [255, 0, 0]);
    const green = doc.image(
      4,
      2,
      () => [0, 255, 0],
      (x) => (x < 2 ? 0 : 255),
    );
    // The half-transparent green raster is drawn over the red one at the same placement.
    doc.page(`${BASE}\nq 40 0 0 20 100 700 cm /G Do Q\n0 0 1 rg 135 715 5 5 re f`, {
      xobjects: {
        I: red,
        G: green,
      },
    });
    const pdf = await open(doc.build());
    try {
      const images = await pdf.getImages();
      const byWidth = (w: number) => images.find((i) => i.width === w)?.id as string;
      const under = await pdf.extractImage(byWidth(40), { composite: true });
      expect(under.composited).toBe('above');
      near(pixel(under.data, 5, 10), RED);
      near(pixel(under.data, 30, 10), GREEN);
      const over = await pdf.extractImage(byWidth(4), { composite: true });
      expect([over.width, over.height, over.composited]).toEqual([4, 2, 'above']);
      // The red draw below stays out of the transparent half.
      expect(pixel(over.data, 0, 1)[3]).toBe(0);
    } finally {
      await pdf.close();
    }
  });
  it('COMP-13: text clipping drawn below the image still clips it', async () => {
    // Clip-only text (mode 7) up to about y 707, then the image and an overlay above it.
    const bytes = pdf((doc, image) =>
      doc.page(
        `q BT 7 Tr /F 10 Tf 100 700 Td (MMMMM) Tj ET\n${BASE}\nQ\n0 0 1 rg 138 700 2 2 re f`,
        { xobjects: { I: image } },
      ),
    );
    const doc = await open(bytes);
    try {
      const [base] = await doc.getImages();
      const view = await doc.extractImage(base.id, { composite: true });
      expect(view.composited).toBe('above');
      const image = decode(view.data);
      let opaqueTop = 0,
        redBottom = 0;
      for (let y = 0; y < 20; y++)
        for (let x = 0; x < 36; x++) {
          const o = (y * image.width + x) * 4;
          // Raster rows above y 8 are above the glyphs; rows 13–19 hold their lower part.
          if (y < 8 && image.data[o + 3] > 0) opaqueTop++;
          if (y >= 13 && image.data[o] > 200 && image.data[o + 3] > 200) redBottom++;
        }
      expect(opaqueTop).toBe(0);
      expect(redBottom).toBeGreaterThan(20);
    } finally {
      await doc.close();
    }
  });
  it('COMP-14: composites on a rotated page match the exact export', async () => {
    const doc = new TestPdf();
    const image = doc.image(40, 20, (x, y) => [x * 6, y * 12, 100]);
    doc.page(`${BASE}\n0 0 1 rg 136 716 4 4 re f`, { xobjects: { I: image }, extra: '/Rotate 90' });
    const pdf = await open(doc.build());
    try {
      const [base] = await pdf.getImages();
      expect(base.occurrences[0].originalOrientation.rotation % 180).toBe(90);
      const exact = decode((await pdf.extractImage(base.id)).data);
      const view = await pdf.extractImage(base.id, { composite: true });
      expect(view.composited).toBe('above');
      expect([view.width, view.height]).toEqual([exact.width, exact.height]);
      const rendered = decode(view.data);
      let different = 0;
      for (let i = 0; i < exact.data.length; i += 4)
        if ([0, 1, 2, 3].some((k) => Math.abs(exact.data[i + k] - rendered.data[i + k]) > 3))
          different++;
      // Only the 4×4 overlay (plus antialiased edges) differs.
      expect(different).toBeGreaterThanOrEqual(16);
      expect(different).toBeLessThanOrEqual(36);
    } finally {
      await pdf.close();
    }
  });
  it('COMP-05: scale, thumbnails, document defaults and per-call overrides', async () => {
    const doc = await open(layered, { composite: true });
    try {
      const [base] = await doc.getImages();
      expect((await doc.extractImage(base.id)).composited).toBe('above');
      expect((await doc.extractImage(base.id, { composite: false })).composited).toBe('none');
      const large = await doc.extractImage(base.id, { scale: 2 });
      expect([large.width, large.height]).toEqual([80, 40]);
      near(pixel(large.data, 30, 20), BLUE);
      const small = await doc.extractImage(base.id, { maxWidth: 20 });
      expect([small.width, small.height, small.variant, small.composited]).toEqual([
        20,
        10,
        'thumbnail',
        'above',
      ]);
    } finally {
      await doc.close();
    }
  });
  it('COMP-06: annotations are included only when enabled', async () => {
    const bytes = pdf((doc, image) => {
      const appearance = doc.add(
        '<< /Type /XObject /Subtype /Form /BBox [0 0 10 10] >>',
        Buffer.from('0 1 0 rg 0 0 10 10 re f'),
      );
      const annotation = doc.add(
        `<< /Type /Annot /Subtype /Square /Rect [125 705 135 715] /F 4 /AP << /N ${appearance} 0 R >> >>`,
      );
      doc.page(BASE, { xobjects: { I: image }, extra: `/Annots [${annotation} 0 R]` });
    });
    const plain = await open(bytes);
    try {
      const [base] = await plain.getImages();
      expect(base.occurrences[0].overlaid).toBe(false);
      expect((await plain.extractImage(base.id, { composite: true })).composited).toBe('none');
      const annotated = await plain.extractImage(base.id, { composite: true, annotations: true });
      expect(annotated.composited).toBe('above');
      near(pixel(annotated.data, 30, 10), GREEN);
      // Per call, getImages counts annotations like extractImage, without changing later calls.
      const [withAnnotations] = await plain.getImages({ annotations: true });
      expect(withAnnotations.occurrences[0].overlaid).toBe(true);
      expect((await plain.getImages())[0].occurrences[0].overlaid).toBe(false);
      await expect(plain.getImages({ annotations: 'yes' as never })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
    } finally {
      await plain.close();
    }
    const doc = await open(bytes, { composite: true, annotations: true });
    try {
      const [base] = await doc.getImages();
      expect(base.occurrences[0].overlaid).toBe(true);
      expect((await doc.getImages({ annotations: false }))[0].occurrences[0].overlaid).toBe(false);
      near(pixel((await doc.extractImage(base.id)).data, 30, 10), GREEN);
    } finally {
      await doc.close();
    }
  });
  it('COMP-07: clipped placements render clipped-away areas transparent', async () => {
    const bytes = pdf((doc, image) =>
      doc.page(`q 100 700 20 20 re W n 40 0 0 20 100 700 cm /I Do Q`, { xobjects: { I: image } }),
    );
    const doc = await open(bytes);
    try {
      const [base] = await doc.getImages();
      expect(base.occurrences[0].overlaid).toBe(false);
      const view = await doc.extractImage(base.id, { composite: true });
      expect(view.composited).toBe('above');
      near(pixel(view.data, 5, 10), RED);
      expect(pixel(view.data, 30, 10)[3]).toBe(0);
    } finally {
      await doc.close();
    }
  });
  it('COMP-09: images in transparency groups are isolated; merged repeats fall back', async () => {
    const half = (doc: TestPdf) =>
      doc.image(
        40,
        20,
        () => [255, 0, 0],
        (x) => (x < 20 ? 0 : 255),
      );
    const grouped = new TestPdf();
    const group = grouped.add(
      `<< /Type /XObject /Subtype /Form /BBox [0 0 600 800] /Group << /S /Transparency /I true >> /Resources << /XObject << /I ${half(grouped)} 0 R >> >> >>`,
      Buffer.from(`${BASE}\n0 0 1 rg 130 705 5 5 re f`),
    );
    grouped.page('0 0 0 rg 90 690 60 40 re f\n/T Do', { xobjects: { T: group } });
    // Consecutive same-size draws of an opaque image become one repeat operator in the
    // renderer: the 2nd–4th here (the first carries a dependency, and a soft mask would add
    // graphics-state operators that prevent the merge).
    const repeated = new TestPdf();
    repeated.page(
      `0 0 0 rg 90 690 210 40 re f\n${[100, 150, 200, 250].map((x) => `q 40 0 0 20 ${x} 700 cm /I Do Q`).join(' ')}\n0 0 1 rg 230 705 5 5 re f`,
      { xobjects: { I: repeated.image(40, 20, () => [255, 0, 0]) } },
    );
    for (const [bytes, occurrence, composited, below] of [
      [grouped.build(), 0, 'above', [0, 0, 0, 0]],
      [repeated.build(), 2, 'page', RED],
    ] as const) {
      const pdf = await open(bytes);
      try {
        const [base] = await pdf.getImages();
        const view = await pdf.extractImage(base.id, {
          composite: true,
          occurrenceId: base.occurrences[occurrence].occurrenceId,
        });
        expect(view.composited).toBe(composited);
        // 'page' reports that content below would show through transparent pixels.
        near(pixel(view.data, 5, 10), below);
        near(pixel(view.data, 25, 10), RED);
        near(pixel(view.data, 32, 12), BLUE);
      } finally {
        await pdf.close();
      }
    }
  });
  it('COMP-08: invalid options and oversized composites fail clearly', async () => {
    await expect(open(layered, { composite: 'yes' as never })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    const doc = await open(layered);
    try {
      const [base] = await doc.getImages();
      for (const scale of [Number.NaN, -1, Number.POSITIVE_INFINITY])
        await expect(doc.extractImage(base.id, { composite: true, scale })).rejects.toMatchObject({
          code: 'INVALID_ARGUMENT',
        });
      await expect(doc.extractImage(base.id, { composite: true, scale: 0 })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
      await expect(
        doc.extractImage(base.id, { composite: true, scale: 1000 }),
      ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' });
    } finally {
      await doc.close();
    }
  });
});
