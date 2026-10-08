Extract structured text and embedded raster images from whole PDFs in browsers and
Node.js **22.12 or newer**. Keep full-resolution exports, thumbnails and stored assets
separate, and use OCR when text exists only inside images.

| Package — usage and API | Responsibility |
| --- | --- |
| {@link "@pdfextract/core" @pdfextract/core} | Whole-PDF text and embedded-image extraction |
| {@link "@pdfextract/ocr" @pdfextract/ocr} | Lazy Tesseract workers and self-hosted models |
| {@link "@pdfextract/storage" @pdfextract/storage} | Filesystem and S3 persistence |

## Installation

Install only the packages you need. OCR and storage are optional additions to core:

```sh
pnpm add @pdfextract/core
# Optional OCR and storage adapters:
pnpm add @pdfextract/ocr @pdfextract/storage
# Required only for the S3 adapter:
pnpm add @aws-sdk/client-s3
```

Use Node.js ≥22.12.0 or a modern browser with ESM support.

## Quick start

Pass a whole `File`, `Blob`, `ArrayBuffer` or `Uint8Array` to `openPdf`; Node `Buffer`
also works. This Node example reads native text and saves each embedded image at its
original resolution, oriented as it appears on the page, with a separate thumbnail:

```ts
import { readFile, writeFile } from 'node:fs/promises';
import { openPdf } from '@pdfextract/core';

const pdf = await openPdf(await readFile('input.pdf'));
try {
  const text = await pdf.getStructuredText({ ocr: 'off' });
  console.log(text.fullText);
  await writeFile('text.json', JSON.stringify(text, null, 2));

  let index = 0;
  for (const image of await pdf.getImages()) {
    const full = await pdf.extractImage(image.id);
    const thumbnail = await pdf.extractImage(image.id, { maxWidth: 320, maxHeight: 240 });
    await writeFile(`image-${index}.png`, full.data);
    await writeFile(`image-${index}-thumbnail.png`, thumbnail.data);
    index++;
  }
} finally {
  await pdf.close();
}
```

In a browser, pass the selected `File` directly and set `assets.baseUrl` to the hosted
core asset directory. Follow the [asset setup guide](guides/ocr-and-assets.md) to copy
the worker, WASM and related files. Exported bytes remain valid after closing the PDF.
Image IDs belong to that open document; persist the exports and their associations
when you need them in another session.

To skip icons and other small images, pass a minimum size to `getImages`. Every image is
listed by default; `ignoredCount` reports how many were left out:

```ts
// Skip icons, bullets and other small images (default: every image is listed).
const images = await pdf.getImages({ minWidth: 100, minHeight: 100 });
console.log(`${images.length} images, ${images.ignoredCount} smaller images ignored`);
```

## Add OCR or persistence

For scanned PDFs and images within mixed-content pages, create a provider with
`createTesseractOcr` and pass it as `openPdf(input, { ocr })`. Supply local or self-hosted
language models. `getStructuredText({ ocr: 'auto' })` then combines native and recognized
text. Close the provider after all PDFs sharing it have closed; see the
[OCR package page](../ocr/README.md).

Use `createFilesystemStorage` in Node or `createS3Storage` with a host-provided AWS SDK
client. Both support `put`, `get`, `head` and `delete`, preserve bytes and metadata, and
return web streams from `get`. See the [storage package page](../storage/README.md) for examples.

## Guides and complete examples

Start with [Getting started](guides/getting-started.md), then configure
[OCR and assets](guides/ocr-and-assets.md) and [storage and persistence](guides/storage.md).
The [coordinates and limits](guides/coordinates-and-limits.md) guide describes fidelity,
resource budgets and lifecycle guarantees.

The [complete browser and Node examples](guides/getting-started.md#run-the-complete-examples)
store text, full-size images and thumbnails, publish a manifest last, and retrieve stored
images in a fresh session. To build or serve this documentation website, see the
[documentation workspace README](README.md).

The host application owns authentication, search/indexing and its UI.
The browser example hands a stored, full-size `File` to a host callback. PDF actions
and embedded external URLs are not executed.

All packages are MIT-licensed. Bundled third-party components keep their own licenses,
listed in each package's `THIRD_PARTY_NOTICES` directory.
