# pdfextract

Three local npm packages for whole-PDF text extraction, embedded raster export,
optional OCR, and byte-preserving storage. Browser and Node.js **≥22.12.0** runtime;
development uses Node **22.22.2**, pnpm **12.4.2**, TypeScript **6.0.3**, Vite **8.3.3**,
Vitest **4.1.11**, Playwright **1.63.0**, and Biome **2.5.15**.

| Package | API |
| --- | --- |
| [`@pdfextract/core`](packages/core/README.md) | `openPdf`, provider contracts, structured text, image inventory/export |
| [`@pdfextract/ocr`](packages/ocr/README.md) | `createTesseractOcr`, lazy self-hosted English/German or caller-selected models |
| [`@pdfextract/storage`](packages/storage/README.md) | `/filesystem` and `/s3`, `put/get/head/delete` |

The private [`@pdfextract/documentation`](packages/documentation/README.md) workspace
generates the TypeDoc website for Cloudflare Pages. Run `pnpm test:docs` to build and
validate it, `pnpm docs:dev` to watch changes, or `pnpm docs:preview` to serve the generated
site at **http://127.0.0.1:4174/**. Its source is versioned under `packages/documentation`;
the root `docs/` directory remains local and ignored.

The private React 19 [`@pdfextract/demo`](packages/demo/README.md) application inspects
user PDFs entirely in browser memory, with native/OCR text, structured JSON and embedded
image downloads. Run `pnpm demo:dev` at **http://127.0.0.1:4176/** or `pnpm test:demo`
for the production build and browser checks. Tagged releases deploy its verified artifact
to a separate Cloudflare Pages project.

The [release guide](packages/documentation/guides/releasing.md) describes npm trusted
publishing and the Cloudflare Pages deployment workflow. Exactly three library tarballs
are published; the documentation workspace is a private static site.
The [CI notes](.github/README.md) describe the Linux-only shared build/test job,
acceptance coverage, dependency cache and optional artifact retention.

The host owns authentication, search/indexing, maps, georeferencing and its UI.
The browser example passes a selected stored full-size **File** to a host callback.
It does not modify or depend on the georeferencing repository.

## Run locally

```sh
git submodule update --init
git -C vendor/canvas submodule update --init skia
git -C vendor/tesseract.js-core submodule update --init
pnpm install --frozen-lockfile
pnpm build
pnpm assets
pnpm dev
```

Open **http://127.0.0.1:4173/pdfextract-demo/**, select a whole PDF, optionally enable
OCR, then select a thumbnail. The default demo storage is IndexedDB. Reload the page
and use **Load stored extraction** to retrieve the manifest/thumbnails without parsing
the PDF again. See [host/S3 configuration](docs/assets-and-examples.md).

```sh
PDFEXTRACT_LANGUAGE_PATH="$PWD/node_modules/@tesseract.js-data/eng/4.0.0" \
  pnpm example:node extract tests/fixtures/mixed.pdf ./pdf-assets
# Use the printed key in a separate invocation:
pnpm example:node load '<document-id>/manifest.json' ./pdf-assets
```

Omit the environment variable for native text without OCR. Ctrl-C cancels the Node
workflow. Both examples use a fresh UUID prefix and publish a validated manifest last.
Full-size bytes are stored once and retrieved unchanged, with SHA-256 verification.

## Core usage

```ts
import { openPdf } from '@pdfextract/core';

const pdf = await openPdf(fileOrBlobOrBuffer);
try {
  const text = await pdf.getStructuredText({ ocr: 'off' });
  const images = await pdf.getImages();
  for (const image of images) {
    const full = await pdf.extractImage(image.id);
    const thumbnail = await pdf.extractImage(image.id, { maxWidth: 320, maxHeight: 240 });
    // full.data and thumbnail.data are independent, owned PNG bytes.
  }
} finally {
  await pdf.close();
}
```

Browser bundlers must configure self-hosted assets; see [asset setup](docs/assets-and-examples.md).
No worker, model, hosted extraction service or external CDN is initialized by import.

## Verify and prepare local artifacts

```sh
pnpm lint
pnpm typecheck
pnpm build
pnpm test
node --test tests/packaging/filesystem.mjs
pnpm assets
pnpm test:e2e
pnpm benchmark
PDFEXTRACT_NODE22=/path/to/node-v22.12.0/bin/node pnpm run pack
pnpm test:packed-browser
pnpm test:linux
```

`pnpm run pack` creates three tarballs in `artifacts/`, installs them into a fresh external
consumer, checks declarations, runs real Node extraction/OCR, and builds the browser
consumer under a non-root base path. The Node 22.12.0 compatibility check runs built JS
independently of Vite.
The browser suite uses Chromium, Firefox and WebKit, including a local MIT-licensed S3
simulator and real CORS/multipart requests. Install missing browsers with
`pnpm exec playwright install chromium firefox webkit`.

Upstream code is cached in pinned Git submodules under `vendor/`. Builds consume the
locked npm distributions, with narrow source-checked patches; they do not build a new PDF
engine. Updating an upstream version requires updating its submodule, patch anchors,
notices and acceptance tests together. [Submodule purposes](docs/upstreams.md) explain
the retained sources and selective initialization above. The [implementation record](docs/implementation-progress.md),
[ADRs](docs/adr/001-engine.md), [acceptance report](docs/acceptance.md),
[fixture provenance](docs/fixtures.md), [benchmarks](docs/benchmarks/README.md),
and [license inventory](docs/licenses.md) describe tested coverage and remaining gaps.

**Release status:** local prerelease artifacts only. The owner's package license is
unresolved (`UNLICENSED` metadata); the existing root MIT file is preserved. Native
canvas binary SBOM/notice evidence and production S3 service validation remain explicit
release/integration items. Local verification commands do not publish or deploy;
the configured release workflow is described in the versioned release guide above.
