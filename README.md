# pdfextract

[![Verify](https://github.com/tobilg/pdfextract/actions/workflows/verify.yml/badge.svg)](https://github.com/tobilg/pdfextract/actions/workflows/verify.yml)
[![npm](https://img.shields.io/npm/v/@pdfextract/core?label=%40pdfextract%2Fcore)](https://www.npmjs.com/package/@pdfextract/core)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Whole-PDF text extraction, embedded raster export, optional OCR and byte-preserving
storage for browsers and Node.js **≥22.12.0**. Everything runs locally: no hosted
extraction service, CDN or model download is used, and nothing starts a worker on import.

| Package | Purpose |
| --- | --- |
| [`@pdfextract/core`](packages/core/README.md) | `openPdf`: structured text with coordinates, embedded-image inventory and lossless PNG export |
| [`@pdfextract/ocr`](packages/ocr/README.md) | `createTesseractOcr`: lazy, self-hosted Tesseract OCR provider for core |
| [`@pdfextract/storage`](packages/storage/README.md) | `/filesystem` and `/s3` adapters with `put/get/head/delete` |

## Installation

```sh
npm install @pdfextract/core
# Optional OCR and storage adapters:
npm install @pdfextract/ocr @pdfextract/storage
# Required only for the S3 adapter:
npm install @aws-sdk/client-s3
```

## Usage

```ts
import { openPdf } from '@pdfextract/core';

const pdf = await openPdf(fileOrBlobOrBuffer);
try {
  const text = await pdf.getStructuredText({ ocr: 'off' });
  console.log(text.fullText);
  for (const image of await pdf.getImages()) {
    const full = await pdf.extractImage(image.id);
    const thumbnail = await pdf.extractImage(image.id, { maxWidth: 320, maxHeight: 240 });
    // full.data and thumbnail.data are independent, owned PNG bytes.
  }
} finally {
  await pdf.close();
}
```

Node works without configuration. Browser bundlers and Web Workers must serve the
packaged engine, worker and OCR assets themselves; see the
[asset setup guide](packages/documentation/guides/ocr-and-assets.md).

More documentation:

- [Getting started](packages/documentation/guides/getting-started.md)
- [OCR and self-hosted assets](packages/documentation/guides/ocr-and-assets.md)
- [Storage and persistence](packages/documentation/guides/storage.md)
- [Coordinates and resource limits](packages/documentation/guides/coordinates-and-limits.md)
- Package READMEs: [core](packages/core/README.md), [ocr](packages/ocr/README.md),
  [storage](packages/storage/README.md)

## Development

Requirements: Node **22.22.2** (any ≥22.12.0 works for running the packages) and
pnpm **12.4.2**.

```sh
git clone https://github.com/tobilg/pdfextract.git
cd pdfextract
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

The build uses the locked npm distributions of PDF.js and Tesseract with small,
anchor-checked patches. The two Git submodules under `vendor/` are **not** needed to
build or test:

- `vendor/tesseract.js-core` provides the native OCR library license texts for
  `node scripts/notices.mjs` (also run `git -C vendor/tesseract.js-core submodule update --init`).
- `vendor/icc-profiles` provides the ICC profiles for regenerating test fixtures with
  `pnpm fixtures`.

```sh
git submodule update --init
```

### Examples

```sh
pnpm assets   # Copy engine, OCR and model assets for the browser example
pnpm dev      # http://127.0.0.1:4173/pdfextract-demo/
```

Select a whole PDF, optionally enable OCR, then select a thumbnail. Results are stored in
IndexedDB; reload the page and use **Load stored extraction** to retrieve the manifest and
thumbnails without parsing the PDF again.

```sh
PDFEXTRACT_LANGUAGE_PATH="$PWD/node_modules/@tesseract.js-data/eng/4.0.0" \
  pnpm example:node extract tests/fixtures/mixed.pdf ./pdf-assets
# Use the printed key in a separate invocation:
pnpm example:node load '<document-id>/manifest.json' ./pdf-assets
```

Omit the environment variable for native text without OCR. Ctrl-C cancels the Node
workflow.

### Websites

- `@pdfextract/documentation` (private) builds the TypeDoc site: `pnpm docs:dev`,
  `pnpm test:docs`, or `pnpm docs:preview` at http://127.0.0.1:4174/.
- `@pdfextract/demo` (private) is a React app that inspects PDFs entirely in browser
  memory: `pnpm demo:dev` at http://127.0.0.1:4176/ or `pnpm test:demo`.

Tagged releases deploy both sites to Cloudflare Pages.

### Verification

```sh
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm assets
pnpm test:e2e                 # Chromium, Firefox and WebKit
pnpm run pack                 # Pack the three tarballs into a clean consumer and test them
pnpm test:packed-browser
pnpm test:linux               # Packed consumer in a Linux container (requires Docker)
pnpm benchmark
```

Install missing browsers with `pnpm exec playwright install chromium firefox webkit`.
`pnpm run pack` writes the tarballs to `artifacts/`, installs them into a fresh external
consumer, checks declarations, runs real Node extraction/OCR and builds the browser
consumer under a non-root base path. Set `PDFEXTRACT_NODE22=/path/to/node-v22.12.0/bin/node`
to also run the Node smoke test on the minimum supported version.
[CI notes](.github/CI.md) describe what the GitHub workflow covers.

## Releasing

`pnpm version:sync X.Y.Z` sets all workspace packages to a release version, including
internal peer ranges; `pnpm version:check` reports drift without writing, and
`--dry-run` previews changes. Pushing a matching `vX.Y.Z` tag runs the full verification
and publishes the tested tarballs with npm trusted publishing. See the
[release guide](packages/documentation/guides/releasing.md).

## License

[MIT](LICENSE). Bundled third-party engines, codecs, fonts and their licenses are listed
in each package's `THIRD_PARTY_NOTICES` directory.
