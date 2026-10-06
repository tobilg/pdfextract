# @pdfextract/demo

Private React 19.3 application built with Vite 8.3.3. It runs whole-PDF extraction in
the browser using the real workspace core and OCR packages. It is a static Cloudflare
Pages website, not an npm release target.

## Run locally

From the repository root, using Node ≥22.12.0 and the installed pnpm:

```sh
pnpm install --frozen-lockfile
pnpm demo:dev
```

Open **http://127.0.0.1:4176/**. Choose or drop a PDF. Enable OCR before extraction to
recognize English or German scans, including images on mixed-content pages. Supply a
password for encrypted PDFs. Change options and select **Extract again** to retry.

The default OCR coverage reads **embedded image regions**. Choose **Whole pages
(including vector text)** for diagrams whose lettering is drawn as paths. If extraction
finds no text or embedded images, the demo offers **Recognize whole pages** directly.
Some schematic/CAD exports contain neither font text nor raster objects; opening them
successfully can therefore yield empty native results. OCR uses a temporary page raster
for recognition only. The embedded-image list remains empty, and no screenshot is
presented as an extracted image. Small technical labels and reading order need review.

```sh
pnpm demo:build
pnpm demo:preview
pnpm exec playwright install chromium firefox webkit
pnpm test:demo
```

The package scripts also work via `pnpm --filter @pdfextract/demo …` after `pnpm build`.
Tests serve the actual production artifact at `/demo/` and exercise Chromium, Firefox,
and WebKit, without Vite transforms or workspace source aliases.

## What the demo does

- Reads a whole File and shows native/OCR text, page dimensions, blocks, lines, span
  geometry, provenance, confidence, warnings and page JSON. Download full structured
  JSON or plain text.
- Lists embedded raster appearances and their distinct placements. Eight thumbnails
  are decoded sequentially per gallery page. Downloading an image requests a separate
  full-resolution PNG with its native dimensions and appearance.
- Reports extraction/export progress, supports cancellation and invalid/password/
  limit errors, and closes document and OCR workers when clearing, replacing or leaving
  the page. Thumbnail and download object URLs are revoked.
- Keeps the PDF and extraction results in memory only. It does not import the storage
  package, upload user PDFs, use IndexedDB/localStorage, or call an extraction service.
  Refreshing the tab starts a new session. Downloads are explicit browser downloads.

PDF handles stay open while viewing results so full images can be decoded on demand.
Only the current gallery page retains thumbnail URLs; full exports are released after
the download starts. Text inspection displays one page at a time. Reading order is
the core package's geometric heuristic; OCR is optional and may be imperfect.

The demo explicitly limits input to 64 MiB, 1,000 pages, 32 million pixels per image,
512 MiB estimated decoded working memory and 4 million OCR working pixels. An image
that exceeds a limit fails explicitly; full exports are never silently reduced.

## Runtime assets and provenance

`scripts/assets.mjs` copies the existing built core/OCR assets and English/German models
using the root `scripts/copy-assets.mjs`. They live in ignored `public/pdfextract/` and
ship in `dist/pdfextract/`, with codec and model notices. No CDN, hosted font, remote
model, server runtime, storage binding or permanent browser credential is required.

React, React DOM, scheduler and the Vite React plugin are MIT-licensed. Vite is MIT;
its native Rolldown toolchain is already covered by the workspace licensing inventory.
PDF.js is Apache-2.0; the copied codec/Tesseract/Leptonica/model notices retain their
upstream terms. The owner's package license remains unresolved (`UNLICENSED`).

The asset audit rejects missing entry assets, more than 20,000 files, or any individual
file above [Cloudflare Pages' 25 MiB limit](https://developers.cloudflare.com/pages/platform/limits/).
Relative application URLs and runtime URLs support a non-root hosting base. `_headers`
sets JavaScript/WASM MIME types and serves models as gzip-file bytes, without manually
adding `Content-Encoding: gzip`. Do not add analytics that receives document contents.

## Tagged-release deployment

`verify.yml` builds and tests the production site, then uploads the `demo` artifact.
On a pushed matching `v*` tag, `release.yml` deploys this exact artifact after verification
and npm publication succeed. Pull requests and manual dry runs do not deploy. The
documentation and demo have separate Pages projects. Exactly three library packages
remain in the npm allowlist; both website packages are checked to remain private.

Create a host-owned **Direct Upload** Pages project named `pdfextract-demo`, with
production branch `main`, and configure these GitHub repository settings:

| Setting | Purpose |
| --- | --- |
| Secret `CLOUDFLARE_API_TOKEN` | Token with Pages edit permission for the account |
| Secret `CLOUDFLARE_ACCOUNT_ID` | Hosting account, shared with the documentation deployment |
| Variable `CLOUDFLARE_DEMO_PAGES_PROJECT` | Optional override for `pdfextract-demo` |

The CI setup follows [Cloudflare's Direct Upload workflow](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/).
Local commands neither provision nor deploy. Release publication remains gated by the
owner's unresolved library license and the existing release prerequisites.

## Validation mapping

`tests/demo.spec.ts` exercises E2E-01, CORE-02/03/04, OCR-01/02/05, IMG-01/02/04 and PERF-02
using the existing real fixtures and independent alpha pixels. Checks include structured
downloads, native-size full images, same-origin OCR, cancellation/recovery, URL cleanup,
fresh-session reset and mobile layout. Fixture provenance remains in the workspace's
local `docs/fixtures.md`; this package generates no synthetic extraction output.
Additional CORE-04/PERF-01 checks cover password recovery and navigation through 150 pages.
`tests/gallery-fixture.mjs` creates original, deterministic PDF test data with nine
distinct one-pixel RGB images using the shared fixture writer. IMG-04/PERF-02 checks
paginate its real extraction and verify old thumbnail URLs are revoked.
The same generator traces an original `VECTOR TEXT 7429` sentinel into filled vector
paths on two pages using the bundled Liberation Sans font (SIL Open Font License).
It embeds neither fonts nor images. CORE-02/OCR-01/OCR-05 checks verify an initially
empty result, the whole-page OCR recovery action, real recognition on both pages and
an unchanged empty image inventory in all three browsers. The user's schematic is
not redistributed as a fixture.
