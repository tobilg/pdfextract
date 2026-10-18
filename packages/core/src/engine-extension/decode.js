// @ts-check
// Image decoding, orientation and PNG encoding.

// Losslessly reorders RGBA pixels so a stored raster appears as its placement shows it on the page.
// `axes` is the linear part of geometry.ts orientationTransform: page directions of the raster's
// x and y axes, each an axis-aligned unit vector.
/**
 * @param {Uint8Array} pixels
 * @param {number} width
 * @param {number} height
 * @param {number[] | undefined} axes
 */
function pdfextractOrient(pixels, width, height, axes) {
  if (!axes || (axes[0] === 1 && axes[3] === 1)) return { pixels, width, height };
  const [ux, uy, vx, vy] = axes,
    outWidth = ux ? width : height,
    outHeight = ux ? height : width,
    offsetX = Math.max(0, -ux) * (width - 1) + Math.max(0, -vx) * (height - 1),
    offsetY = Math.max(0, -uy) * (width - 1) + Math.max(0, -vy) * (height - 1),
    source = new Uint32Array(pixels.buffer, pixels.byteOffset, width * height),
    output = new Uint32Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      output[(uy * x + vy * y + offsetY) * outWidth + ux * x + vx * y + offsetX] =
        source[y * width + x];
  return { pixels: new Uint8Array(output.buffer), width: outWidth, height: outHeight };
}
// Decodes (and optionally orients and encodes) the image draw found by the inventory collector.
/**
 * @param {any} page The engine page.
 * @param {{ info: ImageInfo; item: ImageItem }} target
 * @param {ScanRequest} data
 */
async function pdfextractDecode(page, { info, item }, data) {
  // Referenced images are fetched afresh (cached streams are evicted after each export), so a
  // cached page holds no decoded pixels; inline image streams are rewound instead, and the scan
  // drops the page cache after decoding one.
  const objId = item.image.dict.objId,
    image = objId ? page.xref.fetch(Ref.fromString(objId)) : item.image;
  image.reset();
  const { width, height, stencil, fill, unsupported } = info,
    dict = image.dict,
    maxPixels = data.maxPixels,
    maxBytes = data.maxBytes;
  /** @type {any[]} */
  const dicts = [dict, dict.get('SMask')?.dict, dict.get('Mask')?.dict].filter(Boolean);
  for (const d of dicts) {
    const filters = d.get('F', 'Filter');
    /** @type {any[]} */
    const names = (Array.isArray(filters) ? filters : [filters]).filter(Boolean);
    for (const filter of names) {
      if (
        ![
          'FlateDecode',
          'Fl',
          'DCTDecode',
          'DCT',
          'JPXDecode',
          'CCITTFaxDecode',
          'CCF',
          'JBIG2Decode',
          'ASCIIHexDecode',
          'AHx',
          'ASCII85Decode',
          'A85',
          'LZWDecode',
          'LZW',
          'RunLengthDecode',
          'RL',
        ].includes(filter.name)
      )
        throw new Error('UNSUPPORTED_IMAGE_FEATURE: Unrecognized image filter');
    }
    const count = d.get('W', 'Width') * d.get('H', 'Height');
    if (
      !Number.isSafeInteger(count) ||
      count > (maxPixels ?? Infinity) ||
      count * 16 > (maxBytes ?? Infinity)
    )
      throw new Error('RESOURCE_LIMIT_EXCEEDED: Image decode budget exceeded');
  }
  if (unsupported)
    throw new Error(
      'UNSUPPORTED_IMAGE_FEATURE: Image has a graphics-state soft mask, opacity or blend dependency',
    );
  /** @type {Uint8Array} */
  let pixels;
  if (stencil) {
    const raw = image.getBytes(Math.ceil(width / 8) * height),
      inverse = dict.getArray('D', 'Decode')?.[0] === 1;
    if (raw.length < Math.ceil(width / 8) * height)
      throw new Error('UNSUPPORTED_IMAGE_FEATURE: Truncated stencil');
    pixels = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const bit = (raw[y * Math.ceil(width / 8) + (x >> 3)] >> (7 - (x % 8))) & 1,
          o = (y * width + x) * 4;
        pixels.set(fill, o);
        pixels[o + 3] = (inverse ? bit : 1 - bit) * 255;
      }
  } else {
    const decoded = await PDFImage.buildImage({
      xref: page.xref,
      res: item.resources,
      image,
      isInline: item.isInline,
      pdfFunctionFactory: item.evaluator._pdfFunctionFactory,
      globalColorSpaceCache: page.globalColorSpaceCache,
      localColorSpaceCache: item.localColorSpaceCache,
    });
    let colorSpec = dict.get('CS', 'ColorSpace');
    if (
      colorSpec instanceof Name &&
      !['DeviceRGB', 'DeviceGray', 'DeviceCMYK', 'RGB', 'G', 'CMYK'].includes(colorSpec.name)
    )
      colorSpec = item.resources.get('ColorSpace')?.get(colorSpec.name);
    if (
      Array.isArray(colorSpec) &&
      colorSpec[0]?.name === 'ICCBased' &&
      !(decoded.colorSpace instanceof IccColorSpace)
    )
      throw new Error('UNSUPPORTED_IMAGE_FEATURE: ICC profile could not be color managed');
    /** @param {any} pdfImage */
    function guard(pdfImage) {
      const get = pdfImage.getImageBytes;
      /** @type {(this: any, length: number, options: unknown) => Promise<Uint8Array>} */
      pdfImage.getImageBytes = async function (length, options) {
        const bytes = await get.call(this, length, options);
        if (bytes.length < length)
          throw new Error('UNSUPPORTED_IMAGE_FEATURE: Truncated decoded samples');
        return bytes;
      };
      if (pdfImage.smask) guard(pdfImage.smask);
      if (pdfImage.mask instanceof PDFImage) guard(pdfImage.mask);
    }
    guard(decoded);
    Object.defineProperties(decoded, {
      drawWidth: { value: width },
      drawHeight: { value: height },
    });
    const rgba = await decoded.createImageData(true, false);
    if (
      rgba.width !== width ||
      rgba.height !== height ||
      rgba.kind !== ImageKind.RGBA_32BPP ||
      rgba.data.length !== width * height * 4
    )
      throw new Error(
        'UNSUPPORTED_IMAGE_FEATURE: Decoder did not return a full native RGBA raster',
      );
    pixels = new Uint8Array(rgba.data);
  }
  // Parsed DecodeStreams can cache their pixel buffer. Evict cached image
  // streams after export; later exports reparse from owned PDF bytes.
  page.xref._cacheMap.clear();
  const oriented = pdfextractOrient(pixels, width, height, data.orient);
  if (data.encode)
    return {
      ...info,
      ...pdfextractEncode(
        oriented.pixels,
        oriented.width,
        oriented.height,
        data.maxWidth,
        data.maxHeight,
      ),
    };
  return { ...info, width: oriented.width, height: oriented.height, pixels: oriented.pixels };
}
/**
 * Nearest-neighbor bounded preview (never enlarged) and PNG encoding of an RGBA raster.
 * @param {Uint8Array} pixels
 * @param {number} width
 * @param {number} height
 * @param {number} [maxWidth]
 * @param {number} [maxHeight]
 */
function pdfextractEncode(pixels, width, height, maxWidth, maxHeight) {
  const ratio = Math.min(1, (maxWidth ?? width) / width, (maxHeight ?? height) / height),
    outWidth = Math.max(1, Math.floor(width * ratio)),
    outHeight = Math.max(1, Math.floor(height * ratio));
  let output = pixels;
  if (ratio < 1) {
    output = new Uint8Array(outWidth * outHeight * 4);
    for (let y = 0; y < outHeight; y++)
      for (let x = 0; x < outWidth; x++) {
        const sx = Math.min(width - 1, Math.floor((x + 0.5) / ratio)),
          sy = Math.min(height - 1, Math.floor((y + 0.5) / ratio));
        output.set(
          pixels.subarray((sy * width + sx) * 4, (sy * width + sx) * 4 + 4),
          (y * outWidth + x) * 4,
        );
      }
  }
  return {
    width: outWidth,
    height: outHeight,
    encoded: new Uint8Array(
      pdfextractEncodePng({ width: outWidth, height: outHeight, data: output, channels: 4 }),
    ),
  };
}
/** @param {{ pixels: ArrayBuffer; width: number; height: number; maxWidth?: number; maxHeight?: number }} data */
function pdfextractEncodeRaster(data) {
  return pdfextractEncode(
    new Uint8Array(data.pixels),
    data.width,
    data.height,
    data.maxWidth,
    data.maxHeight,
  );
}
