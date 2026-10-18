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
UserUnit and page rotation applied. `rotation` records PDF rotation. Text order uses
deterministic baseline rows, gutters and paragraph spacing, not semantic reconstruction.
Reading order for overlapping layouts, bidirectional/vertical scripts, or rotated
multi-column content needs application review.

Tables are detected from ruling lines and aligned text columns and returned in
`page.tables` as rows, columns and cells (with merged cells for ruled grids). Each table
is also one text block that reads row by row with tab-separated cells. Pass
`tables: false` to skip detection. See the
[tables guide](../documentation/guides/tables.md) for the heuristics and their limits.

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
