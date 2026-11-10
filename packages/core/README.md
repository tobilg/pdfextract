# @pdfextract/core

Whole-PDF extraction for browsers and Node.js ≥22.12.0. ESM with TypeScript declarations.
Input: `File`, `Blob`, `ArrayBuffer`, `Uint8Array`, including Node `Buffer`. Inputs are
copied before worker transfer; output is owned bytes, never a live WASM view.

## Installation

```sh
pnpm add @pdfextract/core
```

OCR and storage are optional, separate packages.

## Usage

In Node, read the complete PDF before opening it. This example extracts native text
and exports each embedded image without assuming the PDF contains any images:

```ts
import { readFile, writeFile } from 'node:fs/promises';
import { openPdf } from '@pdfextract/core';

const pdf = await openPdf(await readFile('input.pdf'));
try {
  const structured = await pdf.getStructuredText({ ocr: 'off' });
  console.log(structured.fullText);
  await writeFile('text.json', JSON.stringify(structured, null, 2));
  let index = 0;
  for (const image of await pdf.getImages()) {
    const full = await pdf.extractImage(image.id);
    const preview = await pdf.extractImage(image.id, { maxWidth: 320, maxHeight: 240 });
    await writeFile(`image-${index}.png`, full.data);
    await writeFile(`image-${index}-thumbnail.png`, preview.data);
    index++;
  }
} finally {
  await pdf.close();
}
```

In a browser, pass a selected `File` directly to `openPdf(file, { assets })` and configure
the hosted assets described below. Supply `password` in the open options for encrypted
PDFs. To enable OCR, pass a caller-owned provider as `ocr`; the
[@pdfextract/ocr README](../ocr/README.md) shows model configuration and cleanup.

## Structured text

`getStructuredText()` defaults to `auto` with a provider, `off` otherwise. Explicit
`auto`/`always` without a provider throws `OCR_PROVIDER_REQUIRED`. Results contain
schemaVersion, complete/partial status, pages/blocks/lines/spans, warnings, provenance,
and derived fullText. `errorMode: 'collect'` retains partial results with diagnostics;
the default throws. Results round-trip through JSON. Page numbers are one-based.

Coordinates are points (1/72 inch), top-left origin, x right/y down, with CropBox,
UserUnit and page rotation applied. `rotation` records PDF rotation. Text order uses a
deterministic recursive XY-cut: columns are read one after another, and headings, headers
or captions that span the gutter are read in their own place. A gutter is followed through
the rows it runs through, so columns below a title or beside a sidebar are found too, and
on past a scan's drift or around a figure set between the columns. Narrow gutters split only
running text, and in a scan's text layer, whose word gaps can be as wide as a gutter, only
where they run through several lines. OCR words keep the lines the recognizer found. Accents
drawn apart from their letters join them, and letter-spaced runs are read again from their
glyphs. This is not semantic reconstruction: reading order for overlapping
layouts, bidirectional/vertical scripts, or rotated multi-column content needs application
review.

Tables are detected from ruling lines and aligned text columns and returned in
`page.tables` as rows, columns and cells (with merged cells for ruled grids). Each table
is also one text block that reads row by row with tab-separated cells. Pass
`tables: false` to skip detection. See the
[tables guide](../documentation/guides/tables.md) for the heuristics and their limits.

Headings carry `headingLevel` (1 for the largest type on the page): short lines set larger
than the page's body text, or bold where it is not, and lines that only name a conventional
section ("Contents", "References"); running headers and footers, leaders, numbered
captions, dates, links, numbers, lines with tab-separated parts and lines within a sentence
are excluded. Spans report the PDF font name, such as `Helvetica-Bold`. Structure is
heuristic, not read from tagged PDF.

Running headers and footers (journal lines, running titles, page numbers, copyright and
download notices) carry `furniture: 'header' | 'footer'`: blocks in the top or bottom 15% of
the page that are short and set apart from the text, and text repeated at the same height
across the extracted pages. Stamps set at a quarter turn along a side edge carry
`furniture: 'margin'`. Body text near an edge (a paragraph continued from the previous page, a
full-width line unless it cites the publication, a caption, a footnote, a heading) is not
marked. The blocks stay in the text. Line numbers printed beside the text (a manuscript's
numbered lines, a patent's 5, 10, 15 in the gutter) are left out of it.

`toMarkdown(result)` renders headings as `#` lines, tables as pipe tables (as HTML tables
where cells merge, which pipe tables cannot show; `tables: 'pipe' | 'html'` chooses one
syntax) and other blocks as paragraphs, with pages separated by a thematic break
(`pageSeparator` changes it). Paragraphs are written on one line each, with words
hyphenated at a line end rejoined (`lines: 'preserve'` keeps the page's lines).
`furniture: false` leaves running headers and footers out, as for a model or a search
index. It works on any result, including one restored from JSON:

```ts
import { openPdf, toMarkdown } from '@pdfextract/core';

const markdown = toMarkdown(await pdf.getStructuredText());
const body = toMarkdown(await pdf.getStructuredText(), { furniture: false });
```

On pages typeset with TeX (papers from LaTeX, arXiv preprints), `math: 'latex'` rebuilds
formulas from their glyphs and puts them in the text as `$…$` LaTeX: math fonts (Computer
Modern, AMS, Latin Modern, tx/px, mathabx, Euler, rsfs, OpenType math fonts such as STIX Two
Math) and TeX's encodings give the symbols, glyph size and baseline the sub- and superscripts,
thin rules the fractions, roots and overlines, and centred script rows the limits of sums and
integrals; operator names beside them join them. Text around a formula keeps its own spans.
Formulas with structure plain text cannot show or of three glyphs or more become LaTeX, so a
lone `±` or Greek letter stays text; pages without math fonts are unaffected, and others cost
one more glyph scan. No model is involved, and math drawn as images or vector outlines, or set
in text fonts only, is not read:

```ts
const markdown = toMarkdown(await pdf.getStructuredText({ math: 'latex' }));
// … where $x_{i}\in \mathbb{R}^{n}$ and $\sum_{i=1}^{n}x_{i}=1$ …
```

With OCR, `auto` recognizes embedded images, except those that native text already covers
(backgrounds, watermarks) and scans under a text layer that reads cleanly; a scan under a
poor layer (debris of an earlier recognition) is recognized again, and the new words replace
the layer where they read clearly better. On a page with no native text that
is drawn with many vector shapes (outlined lettering), the rendered page. Recognized words
below `minOcrConfidence` (default 0.3; 0 keeps all) are dropped, and words that repeat
overlapping native text, including close misreadings, are not added. Any `OcrProvider` can
recognize: rasters carry their effective `dpi` when known and `layout: 'sparse'` when core
asks for scattered words (a page that yielded no text otherwise), and a provider reporting
`concurrency` above one gets that many pages at once.

The [text and Markdown guide](../documentation/guides/text-and-markdown.md)
describes reading order, headings, furniture, Markdown and math in more detail.

## Embedded images

Images have document-scoped IDs, original dimensions, appearance variants, and distinct
occurrences with `imageToPage: [a,b,c,d,e,f]` mapping top-left raster pixel edges into
canonical page coordinates. Nested forms, inline images, tiny assets and reused images
are included. Auxiliary masks are applied. Page clipping is reported, not baked into
the standalone asset. Full PNG output preserves native resolution, RGBA8 transparency
and sRGB appearance within the documented color envelope.

PDFs often store an image mirrored or turned and flip it back when drawing it. Exports
show the image **as it appears on the page**: mirrored and quarter-turn placements are
corrected losslessly (pixels are reordered, never resampled), so a 90° placement swaps
width and height. Each occurrence reports the stored raster's `originalOrientation`
(`{ rotation: 0 | 90 | 180 | 270, mirrored }`). The first occurrence decides the export
orientation unless you pass `occurrenceId`; pass `preserveOrientation: true` to get the
raster exactly as stored. Regional OCR also reads the corrected raster.

```ts
const upright = await pdf.extractImage(image.id); // as on the page
const stored = await pdf.extractImage(image.id, { preserveOrientation: true });
```

### Minimum image size

`getImages` lists every image by default. Pass `minWidth` and/or `minHeight` (positive
whole pixels) to leave out smaller images such as icons, bullets or spacer pixels. Sizes are
measured as exported by default, so a quarter-turn placement counts with width and height
swapped. The returned array keeps its type and adds `ignoredCount`, the number of images on
the selected pages that were left out (`0` without a filter; it is not part of JSON output).
The filter only shapes the list: OCR still reads every image region, and `extractImage`
still accepts any image ID.

```ts
// Skip icons, bullets and other small images (default: every image is listed).
const images = await pdf.getImages({ minWidth: 100, minHeight: 100 });
console.log(`${images.length} images, ${images.ignoredCount} smaller images ignored`);
```

Pages whose content has errors (for example text shown before any font is set) are read
leniently, skipping the broken operators, instead of failing the whole list. The list's
`warnings` (also not part of JSON output) then has an `IMAGE_INVENTORY_DEGRADED` entry for
each such selected page, since images in the broken part may be missing. Composites and
full-page OCR render pages leniently too, as viewers do, while text extraction keeps
reporting such errors.

### Composite exports

Some tools export plans and drawings as stacked layers: a base image with text, vector
markup or further images drawn over it. Each occurrence reports `overlaid: true` when the
page draws something visible above it within its area. Pass `composite: true` (per call, or
as a document default to `openPdf`) to export the image **as it appears on the page**: the
image plus everything drawn above it, in drawing order, cropped to the image's area.
Content drawn below the image is left out.

```ts
const pdf = await openPdf(bytes, { composite: true, annotations: true });
const [image] = await pdf.getImages();
const view = await pdf.extractImage(image.id); // composite, with annotations
console.log(view.composited); // 'above', or 'none' when nothing is drawn above
```

- The output keeps the image's native size and orientation (90° placements swap width and
  height); `scale` (any positive factor, e.g. `1.5`) multiplies it, and
  `maxWidth`/`maxHeight` request a thumbnail of the composite.
- `annotations: true` includes annotation appearances (stamps, markup, form fields).
  Both `composite` and `annotations` default to false. `getImages({ annotations: true })`
  counts annotations in `overlaid` the same way.
- A composite is a render, not a lossless export: the image passes through a canvas.
  Occurrences that are neither overlaid (nor, with `annotations: true`, covered by an
  annotation) nor clipped export the exact stored pixels instead, reported as
  `composited: 'none'`, unless a `scale` other than 1 asks for a render.
- Images whose appearance depends on an unsupported graphics state (a soft mask, opacity
  or blend mode; see the image's `warnings`) fail as full exports but are rendered as
  composites, which show them as the page does.
- Clipped placements render the clipped-away areas transparent, unlike the full export.
  A clip counts only when it cuts into the image: a page-wide clip or a Form XObject that
  contains the image leaves `clipped` false, while non-rectangular, rotated and text clips
  count conservatively.
- `composited: 'page'` means the image's own draw could not be isolated (for example when
  the renderer merged repeated draws of one image), so content drawn below it is included
  where the image is transparent.
- Composites must fit a canvas of 16,777,216 pixels and 32,767 pixels per side (and
  `maxImagePixels`/`maxDecodedBytes`); larger ones fail with `RESOURCE_LIMIT_EXCEEDED`.
- `overlaid` only counts what is visible within the clip area. A stroked outline counts
  where its lines cross the image, so a frame around it does not. Text extents are
  estimated from the font's glyph widths (horizontal or vertical writing) and a fixed line
  height, so it errs towards true; invisible text such as an OCR layer does not count.
- In Node, composites need the optional `@napi-rs/canvas` peer dependency.

Thumbnails are explicitly requested, aspect-preserving nearest-neighbor previews;
they never mutate a full export. Composites are only produced on request.

Tested filters: Flate, DCT/JPEG, lossless JPX, CCITT Group4, JBIG2 MMR generic regions.
Tested colors: DeviceGray/RGB, Indexed, CMYK through the bundled ICC profile, ICC RGB
including DisplayP3; Decode inversion, color-key masks, soft masks and stencil variants.
Higher-bit-depth samples become RGBA8. PNG is lossless for exported pixels, not the
original compressed/CMYK/high-bit-depth representation. Arbitrary blend/background or
graphics-state soft-mask/opacity dependencies fail explicitly in full exports; composite
exports (on request) render them. Broader JBIG2/JPX modes,
spot colors and malformed ICC profiles have no blanket fidelity guarantee.

## Limits, cancellation and lifecycle

Defaults: 256 MiB input, 10,000 pages, 64 million image pixels, 1 GiB estimated decoded
working memory, 16 million OCR pixels, 200,000 cached ruling lines for table detection
(`maxCachedRuleLines`, about 8 MB). Configure `limits` to suit the environment.
The decoded budget uses a conservative 16 bytes/pixel estimate including auxiliaries;
it is not a hard process-RSS sandbox. One document job runs at a time. Whole source and
parsing structures remain resident; decoded images are evicted after export. Full output
never silently downscales. Browser allocation failures remain possible within large budgets.

All operations accept `signal` and `onProgress`. Aborting cancels queued work immediately;
a bounded synchronous decode already running in the worker may finish before cleanup.
`close()` is idempotent, releases the engine and never closes a caller-owned OCR provider.
After close, operations fail with `DOCUMENT_CLOSED`; previously returned data remains valid.
Callers should close PDFs/providers in finally blocks and consume/cancel storage streams.

`PdfExtractError` provides `code`, `cause`, `context`, and optional `cleanupErrors`.
Codes cover invalid/password input, cancellation, limits, unsupported images, text/OCR
failures and storage outcomes. PDF actions/external embedded URLs are not executed.

## Runtime assets

Node resolves included engine assets automatically. For bundled browser applications,
copy the entire exported `@pdfextract/core/assets/*` tree and set
`assets: { baseUrl: new URL('/your/base/pdfextract/core/', location.origin) }`.
`workerUrl` can override the patched worker; `wasmUrl` identifies a file in the directory
containing qcms/OpenJPEG assets. Keep sibling files and notices. See the repository
asset guide for MIME/CSP details. Core does not import AWS or Tesseract implementations.
Node full-page OCR (`ocr: 'always'`) and composite image export render pages with the
optional peer dependency `@napi-rs/canvas`; install it only if you need them
(`npm install @napi-rs/canvas`). Without it, `always` rejects with `OCR_ASSET_UNAVAILABLE`
and composites with `UNSUPPORTED_IMAGE_FEATURE`.
The same configuration works in a window or a dedicated module Web Worker; Node is
selected by the package's `node` export condition, not by runtime global checks.

See the [asset setup guide](../documentation/guides/ocr-and-assets.md) for browser
hosting and the [storage README](../storage/README.md) to persist exports for later use.

## License

MIT. Third-party engine/codecs/fonts retain their licenses in `THIRD_PARTY_NOTICES`
and `dist/assets`.
