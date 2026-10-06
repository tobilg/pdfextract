---
title: Getting started
group: Guides
---

# Getting started

Use whole `File`, `Blob`, `ArrayBuffer` or `Uint8Array` input; Node `Buffer` works too.
Path strings and remote range requests are outside the input contract. Node applications
can read a file first, then pass its bytes to {@link "@pdfextract/core".openPdf}.

```sh
pnpm add @pdfextract/core @pdfextract/ocr @pdfextract/storage
```

The libraries support browser ESM and Node ≥22.12.0. Configure browser workers using
[self-hosted assets](ocr-and-assets.md) before opening a PDF in a bundled application.

## Native text and images

This typechecked Node example returns owned exports that remain usable after close:

{@includeCode ../examples/extract.ts}

For large documents, upload each full image and thumbnail inside the loop instead of
accumulating all exports in an array. The engine decodes on demand; the application
controls the lifetime of the resulting bytes.

The document's four operations are `getStructuredText`, `getImages`, `extractImage`
and `close`. The structured result includes pages, blocks, lines, spans, provenance,
warnings and derived `fullText`. It round-trips through JSON.

## Run the complete examples

From the repository root, run `pnpm build && pnpm assets && pnpm dev` and open
`http://127.0.0.1:4173/pdfextract-demo/`. The default browser adapter uses IndexedDB.
Reload the page and load the saved extraction to retrieve its manifest and thumbnails
without parsing the PDF again. Select an image to receive the stored full-size `File`.

```sh
PDFEXTRACT_LANGUAGE_PATH="$PWD/node_modules/@tesseract.js-data/eng/4.0.0" \
  pnpm example:node extract tests/fixtures/mixed.pdf ./pdf-assets
pnpm example:node load '<printed-manifest-key>' ./pdf-assets
```

The source examples are in the repository's
[browser](https://github.com/tobilg/pdfextract/tree/main/examples/browser) and
[Node](https://github.com/tobilg/pdfextract/tree/main/examples/node) directories.
