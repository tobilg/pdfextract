# @pdfextract/core

Whole-PDF extraction for browsers and Node.js ≥22.12.0. ESM with TypeScript declarations.
Input: `File`, `Blob`, `ArrayBuffer`, `Uint8Array`, including Node `Buffer`. Inputs are
copied before worker transfer; output is owned bytes, never a live WASM view.

## Installation

```sh
pnpm add @pdfextract/core
```

Before the first npm release, install the local core `.tgz` produced by `pnpm pack`
in the repository. OCR and storage are optional, separate packages.

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
Reading order for complex tables, overlapping layouts, bidirectional/vertical scripts,
or rotated multi-column content needs application review.

## Embedded images

Images have document-scoped IDs, original dimensions, appearance variants, and distinct
occurrences with `imageToPage: [a,b,c,d,e,f]` mapping top-left raster pixel edges into
canonical page coordinates. Nested forms, inline images, tiny assets and reused images
are included. Auxiliary masks are applied. Page clipping is reported, not baked into
the standalone asset. Full PNG output preserves native width/height, orientation,
RGBA8 transparency and sRGB appearance within the documented color envelope.
Thumbnails are explicitly requested, aspect-preserving nearest-neighbor previews;
they never mutate a full export. No screenshot/composite substitutes for an image.

Tested filters: Flate, DCT/JPEG, lossless JPX, CCITT Group4, JBIG2 MMR generic regions.
Tested colors: DeviceGray/RGB, Indexed, CMYK through the bundled ICC profile, ICC RGB
including DisplayP3; Decode inversion, color-key masks, soft masks and stencil variants.
Higher-bit-depth samples become RGBA8. PNG is lossless for exported pixels, not the
original compressed/CMYK/high-bit-depth representation. Arbitrary blend/background or
graphics-state soft-mask/opacity dependencies fail explicitly. Broader JBIG2/JPX modes,
spot colors and malformed ICC profiles have no blanket fidelity guarantee.

## Limits, cancellation and lifecycle

Defaults: 256 MiB input, 10,000 pages, 64 million image pixels, 1 GiB estimated decoded
working memory, 16 million OCR pixels. Configure `limits` to suit the environment.
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
Optional `@napi-rs/canvas` is used only for Node full-page OCR (`always`).

See the [asset setup guide](../documentation/guides/ocr-and-assets.md) for browser
hosting and the [storage README](../storage/README.md) to persist exports for later use.

## License

License decision pending: UNLICENSED local prerelease. Third-party engine/codecs/fonts
retain their licenses in `THIRD_PARTY_NOTICES` and `dist/assets`.
