import type { ImageOccurrence, OcrRaster, PdfLimits } from './contracts.js';
import type { Engine } from './engine.js';
import { orientationTransform } from './geometry.js';
import type { ImageLocation } from './inventory.js';

/** Linear part of the transform that shows an occurrence's raster upright, as on the page. */
function axes(occurrence: ImageOccurrence) {
  return orientationTransform(occurrence.originalOrientation, 1, 1).slice(0, 4);
}
/** The exact stored pixels as PNG, oriented like the occurrence unless preserved, optionally bounded. */
export async function exactExport(
  engine: Engine,
  limits: Required<PdfLimits>,
  location: ImageLocation,
  occurrence: ImageOccurrence,
  options: { maxWidth?: number; maxHeight?: number; preserveOrientation?: boolean },
) {
  const source = await engine.decode(
    location.pageIndex,
    location.rawId,
    limits.maxImagePixels,
    limits.maxDecodedBytes,
    {
      encode: true,
      maxWidth: options.maxWidth,
      maxHeight: options.maxHeight,
      ...(options.preserveOrientation ? {} : { orient: axes(occurrence) }),
    },
  );
  return {
    width: source.width as number,
    height: source.height as number,
    data: new Uint8Array(source.encoded),
  };
}
/** The occurrence's raster as upright RGBA, as the placement shows it, for OCR. */
export async function uprightRaster(
  engine: Engine,
  limits: Required<PdfLimits>,
  location: ImageLocation,
  occurrence: ImageOccurrence,
): Promise<OcrRaster> {
  const raw = await engine.decode(
    location.pageIndex,
    location.rawId,
    limits.maxImagePixels,
    limits.maxDecodedBytes,
    { orient: axes(occurrence) },
  );
  return {
    data: new Uint8Array(raw.pixels),
    width: raw.width,
    height: raw.height,
    stride: raw.width * 4,
    format: 'rgba8',
  };
}
