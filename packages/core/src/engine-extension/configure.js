// @ts-check
// Engine compatibility checks and startup configuration (assets, ICC color management).

const pdfextractSyncAssets = new Map();
// Engine operators the scan below relies on.
const PDFEXTRACT_OPS = [
  'save',
  'restore',
  'paintFormXObjectBegin',
  'paintFormXObjectEnd',
  'transform',
  'clip',
  'eoClip',
  'setFillRGBColor',
  'setStrokeRGBColor',
  'setFillColorN',
  'setStrokeColorN',
  'setLineWidth',
  'constructPath',
  'endPath',
  'stroke',
  'closeStroke',
  'fill',
  'eoFill',
  'fillStroke',
  'eoFillStroke',
  'closeFillStroke',
  'closeEOFillStroke',
  'shadingFill',
  'beginText',
  'endText',
  'setTextMatrix',
  'moveText',
  'setLeadingMoveText',
  'setLeading',
  'nextLine',
  'setFont',
  'setCharSpacing',
  'setWordSpacing',
  'setHScale',
  'setTextRise',
  'setTextRenderingMode',
  'showText',
  'setGState',
];
/** @param {Record<string, Uint8Array>} data */
function pdfextractConfigure(data) {
  // Fail clearly when an upgraded engine renamed an operator the scan relies on.
  const missing = [
    ...PDFEXTRACT_OPS.filter((name) => typeof OPS[name] !== 'number').map((name) => `OPS.${name}`),
    ...Object.entries(pdfextractInternals())
      .filter(([, present]) => !present)
      .map(([name]) => name),
  ];
  if (missing.length)
    throw new Error(`pdfextract: unsupported PDF.js engine, missing ${missing.join(', ')}`);
  for (const [name, bytes] of Object.entries(data)) pdfextractSyncAssets.set(name, bytes);
  IccColorSpace._module = QCMS._module = initSync({ module: data['qcms_bg.wasm'] });
  Object.defineProperty(IccColorSpace, 'isUsable', { value: true, configurable: true });
  Object.defineProperty(CmykICCBasedCS, 'isUsable', { value: true, configurable: true });
  return true;
}
/**
 * Engine classes and functions the extension calls, by name, with whether each is present.
 * `typeof` keeps a renamed global from throwing here.
 * @returns {Record<string, boolean>}
 */
function pdfextractInternals() {
  const fn = (/** @type {unknown} */ value) => typeof value === 'function';
  return {
    'PartialEvaluator.prototype.getOperatorList':
      typeof PartialEvaluator !== 'undefined' && fn(PartialEvaluator.prototype?.getOperatorList),
    'PartialEvaluator.prototype.handleSetFont':
      typeof PartialEvaluator !== 'undefined' && fn(PartialEvaluator.prototype?.handleSetFont),
    'PartialEvaluator.prototype.buildPaintImageXObject':
      typeof PartialEvaluator !== 'undefined' &&
      fn(PartialEvaluator.prototype?.buildPaintImageXObject),
    OperatorList: typeof OperatorList !== 'undefined' && fn(OperatorList),
    WorkerTask: typeof WorkerTask !== 'undefined' && fn(WorkerTask),
    'PDFImage.buildImage': typeof PDFImage !== 'undefined' && fn(PDFImage?.buildImage),
    'Ref.fromString': typeof Ref !== 'undefined' && fn(Ref?.fromString),
    'ImageKind.RGBA_32BPP':
      typeof ImageKind !== 'undefined' && typeof ImageKind?.RGBA_32BPP === 'number',
    IccColorSpace: typeof IccColorSpace !== 'undefined' && fn(IccColorSpace),
    CmykICCBasedCS: typeof CmykICCBasedCS !== 'undefined' && fn(CmykICCBasedCS),
    QCMS: typeof QCMS !== 'undefined' && !!QCMS,
    initSync: typeof initSync !== 'undefined' && fn(initSync),
    Name: typeof Name !== 'undefined' && fn(Name),
  };
}
