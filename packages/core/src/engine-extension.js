/* Appended to the exact PDF.js worker by scripts/build.mjs. All engine names
 * below are private to that pinned worker. No engine types cross the API. */
const pdfextractSyncAssets = new Map();

import { encodePng as pdfextractEncodePng } from './png.mjs';

// biome-ignore lint/correctness/noUnusedVariables: Called by the generated worker RPC handler.
function pdfextractConfigure(data) {
  for (const [name, bytes] of Object.entries(data)) pdfextractSyncAssets.set(name, bytes);
  IccColorSpace._module = QCMS._module = initSync({ module: data['qcms_bg.wasm'] });
  Object.defineProperty(IccColorSpace, 'isUsable', { value: true, configurable: true });
  Object.defineProperty(CmykICCBasedCS, 'isUsable', { value: true, configurable: true });
  return true;
}
const pdfextractMultiply = (m, n) => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
// biome-ignore lint/correctness/noUnusedVariables: Called by the generated worker RPC handler.
async function pdfextractScan(manager, handler, data) {
  const page = await manager.getPage(data.pageIndex);
  await page.loadResources([
    'ColorSpace',
    'ExtGState',
    'Font',
    'Pattern',
    'Properties',
    'Shading',
    'XObject',
  ]);
  const images = [];
  const evaluator = new PartialEvaluator({
    xref: page.xref,
    handler,
    pageIndex: page.pageIndex,
    idFactory: page._localIdFactory,
    fontCache: page.fontCache,
    builtInCMapCache: page.builtInCMapCache,
    standardFontDataCache: page.standardFontDataCache,
    globalColorSpaceCache: page.globalColorSpaceCache,
    globalImageCache: page.globalImageCache,
    systemFontCache: page.systemFontCache,
    options: { ...page.evaluatorOptions, ignoreErrors: false },
  });
  evaluator.buildPaintImageXObject = async function (args) {
    const index = images.push({ ...args, evaluator: this }) - 1;
    args.operatorList.addOp(1001, [index]);
  };
  const list = new OperatorList();
  await evaluator.getOperatorList({
    stream: await page.getContentStream(),
    task: new WorkerTask('pdfextract inventory'),
    resources: page.resources,
    operatorList: list,
  });
  let state = {
    matrix: [1, 0, 0, 1, 0, 0],
    fill: [0, 0, 0],
    clipped: false,
    unsupported: false,
    variant: '',
  };
  const stack = [],
    out = [];
  for (let i = 0; i < list.fnArray.length; i++) {
    const op = list.fnArray[i],
      args = list.argsArray[i];
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) {
      stack.push(structuredClone(state));
      if (op === OPS.paintFormXObjectBegin) {
        if (args[0]) state.matrix = pdfextractMultiply(state.matrix, args[0]);
        if (args[1]) state.clipped = true;
      }
    } else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) state = stack.pop() ?? state;
    else if (op === OPS.transform) state.matrix = pdfextractMultiply(state.matrix, args);
    else if (op === OPS.clip || op === OPS.eoClip) state.clipped = true;
    else if (op === OPS.setFillRGBColor) state.fill = Array.from(args);
    else if (op === OPS.setGState) {
      for (const [key, value] of args[0])
        if (
          (key === 'SMask' && value) ||
          (key === 'BM' && value !== 'source-over') ||
          (key === 'ca' && value !== 1)
        ) {
          state.unsupported = true;
          state.variant += JSON.stringify([key, value]);
        }
    } else if (op === 1001) {
      const item = images[args[0]],
        dict = item.image.dict,
        stencil = !!dict.get('IM', 'ImageMask');
      const width = dict.get('W', 'Width'),
        height = dict.get('H', 'Height');
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
        throw new Error('RESOURCE_LIMIT_EXCEEDED: Invalid image dimensions');
      const ref = dict.objId ?? `inline-${data.pageIndex}-${args[0]}`;
      const id = `${ref}${stencil ? `-${state.fill.join('-')}` : ''}${state.variant}`;
      const info = {
        id,
        width,
        height,
        bitsPerComponent: dict.get('BPC', 'BitsPerComponent') ?? 1,
        colorSpace: String(dict.get('CS', 'ColorSpace')?.name ?? 'complex'),
        hasAlpha: stencil || dict.has('SMask') || dict.has('Mask'),
        matrix: state.matrix.slice(),
        clipped: state.clipped,
        unsupported: state.unsupported,
        index: args[0],
        stencil,
        fill: state.fill.slice(),
      };
      out.push(info);
      if (data.decodeId === id) {
        const maxPixels = data.maxPixels,
          maxBytes = data.maxBytes;
        for (const d of [dict, dict.get('SMask')?.dict, dict.get('Mask')?.dict].filter(Boolean)) {
          const filters = d.get('F', 'Filter');
          for (const filter of (Array.isArray(filters) ? filters : [filters]).filter(Boolean)) {
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
          if (!Number.isSafeInteger(count) || count > maxPixels || count * 16 > maxBytes)
            throw new Error('RESOURCE_LIMIT_EXCEEDED: Image decode budget exceeded');
        }
        if (state.unsupported)
          throw new Error(
            'UNSUPPORTED_IMAGE_FEATURE: Image has a graphics-state soft mask, opacity or blend dependency',
          );
        let pixels;
        if (stencil) {
          item.image.reset();
          const raw = item.image.getBytes(Math.ceil(width / 8) * height),
            inverse = dict.getArray('D', 'Decode')?.[0] === 1;
          if (raw.length < Math.ceil(width / 8) * height)
            throw new Error('UNSUPPORTED_IMAGE_FEATURE: Truncated stencil');
          pixels = new Uint8Array(width * height * 4);
          for (let y = 0; y < height; y++)
            for (let x = 0; x < width; x++) {
              const bit = (raw[y * Math.ceil(width / 8) + (x >> 3)] >> (7 - (x % 8))) & 1,
                o = (y * width + x) * 4;
              pixels.set(state.fill, o);
              pixels[o + 3] = (inverse ? bit : 1 - bit) * 255;
            }
        } else {
          const decoded = await PDFImage.buildImage({
            xref: page.xref,
            res: item.resources,
            image: item.image,
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
          function guard(image) {
            const get = image.getImageBytes;
            image.getImageBytes = async function (length, options) {
              const bytes = await get.call(this, length, options);
              if (bytes.length < length)
                throw new Error('UNSUPPORTED_IMAGE_FEATURE: Truncated decoded samples');
              return bytes;
            };
            if (image.smask) guard(image.smask);
            if (image.mask instanceof PDFImage) guard(image.mask);
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
        if (data.encode) {
          const ratio = Math.min(
              1,
              (data.maxWidth ?? width) / width,
              (data.maxHeight ?? height) / height,
            ),
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
            ...info,
            width: outWidth,
            height: outHeight,
            encoded: new Uint8Array(
              pdfextractEncodePng({
                width: outWidth,
                height: outHeight,
                data: output,
                channels: 4,
              }),
            ),
          };
        }
        return { ...info, pixels };
      }
    }
  }
  if (data.decodeId) throw new Error('IMAGE_NOT_FOUND: Image missing from page');
  return out;
}
