---
title: Coordinates, fidelity and limits
group: Guides
---

# Coordinates, fidelity and limits

Core returns canonical page coordinates in points (1/72 inch), with a top-left origin,
x right and y down. CropBox, UserUnit and page rotation are applied. Page numbers are
one-based; `rotation` records the original PDF rotation. Reading order is a deterministic
baseline/gutter/paragraph heuristic, not semantic recovery for arbitrary tables or scripts.

Each image occurrence has an `imageToPage` transform `[a,b,c,d,e,f]`, mapping top-left
raster pixel edges to page coordinates: `x′ = a*x + c*y + e`, `y′ = b*x + d*y + f`.
Distinct repeated occurrences retain their own placement IDs and transforms. Image IDs
belong to one document and appearance variant; persist their associations in a manifest.

Full image export preserves native dimensions even when the PDF draws an image small.
Inline, nested-form, reused and tiny images are included. Auxiliary masks are applied.
Page clipping is reported on occurrences and does not crop the standalone asset. Explicit
thumbnail bounds request a separate aspect-preserving nearest-neighbor preview.

## Tested fidelity envelope

PNG output contains RGBA8 pixels in sRGB appearance, not original compressed/CMYK samples.
Tested paths include RGB/gray/indexed, CMYK and ICC RGB (including DisplayP3), Decode
inversion, color-key/soft masks and colored stencil variants. Lossless fixture samples
and alpha compare exactly; independent LittleCMS references use documented small color tolerances.

Tested codecs include Flate, JPEG, lossless JPX, CCITT Group4 and JBIG2 MMR generic regions.
This is not blanket coverage of every codec mode, spot color or malformed profile.
Unsupported compositing/graphics-state dependencies fail explicitly instead of silently
returning a screenshot or degraded raster.

## Resource and lifecycle contract

| Default budget | Value |
| --- | --- |
| Whole input | 256 MiB |
| Pages | 10,000 |
| Native image | 64 million pixels |
| Estimated decoded working memory | 1 GiB |
| OCR working raster | 16 million pixels |

Override {@link "@pdfextract/core".PdfLimits} to suit the host. Full exports reject a
budget failure rather than downscaling. Decoded memory is estimated at 16 bytes/pixel,
not an enforced process-RSS sandbox. Source bytes and parser structures remain resident;
decoded images are evicted after export. Application-held output arrays still consume memory.

One document job runs at a time. Cancellation stops queued work immediately; a synchronous
decode already running in a worker may finish before cleanup. `close()` is idempotent and
joins worker cleanup. Results own their bytes and survive close. Calls after close fail;
closing a PDF never closes its borrowed OCR provider.

Generated fixtures establish a 150-page result and full 8000×5000 export in a provisioned
Node environment. Browser tests exercise a clear configured limit for that 40 MP case.
There is no unlimited-browser-image or throughput guarantee. The local benchmark command
records hardware, separate stage timings, peak RSS and repeated worker/buffer measurements.
