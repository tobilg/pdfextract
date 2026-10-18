// @ts-check
// Page operator lists (with the one-page cache) and the scan entry point.

/**
 * The last page whose operator list was built, kept so consecutive scans of one page (such as
 * exporting each of its images) build it once. The worker serves a single document and ends
 * with it; the manager is checked anyway.
 * @type {PageEntry | undefined}
 */
let pdfextractLastPage;
/**
 * @typedef {object} PageEntry
 * @property {any} manager
 * @property {number} pageIndex
 * @property {boolean} strict Whether the scan asked for a strict operator list.
 * @property {string} [degraded] Why the strict list failed, when this lenient list replaced it.
 * @property {any} page
 * @property {any} list
 * @property {ImageItem[]} images
 * @property {Map<string, FontMetrics>} fonts
 */
/**
 * A page's operator list, with image draws recorded as operator 1001 (indexing `images`).
 * Image scans ask for a strict list, so content errors are not silently skipped; when the
 * strict list fails, the page is built leniently (skipping broken operators, as text
 * extraction does) and marked `degraded`, so one broken text or graphics operator does not stop
 * the image inventory. Rule scans are always lenient: they only inform table detection.
 * @param {any} manager
 * @param {any} handler
 * @param {number} pageIndex
 * @param {boolean} strict
 * @returns {Promise<PageEntry>}
 */
async function pdfextractPage(manager, handler, pageIndex, strict) {
  const last = pdfextractLastPage;
  if (
    last &&
    last.manager === manager &&
    last.pageIndex === pageIndex &&
    // A degraded lenient list stands in for the strict one, which fails again.
    (last.strict === strict || (strict && last.degraded !== undefined))
  )
    return last;
  pdfextractLastPage = undefined;
  /** @type {string | undefined} */
  let degraded;
  let built;
  try {
    built = await pdfextractBuild(manager, handler, pageIndex, !strict);
  } catch (error) {
    if (!strict) throw error;
    degraded = String(/** @type {any} */ (error)?.message ?? error);
    built = await pdfextractBuild(manager, handler, pageIndex, true);
  }
  pdfextractLastPage = { manager, pageIndex, strict, degraded, ...built };
  return pdfextractLastPage;
}
/**
 * @param {any} manager
 * @param {any} handler
 * @param {number} pageIndex
 * @param {boolean} ignoreErrors
 */
async function pdfextractBuild(manager, handler, pageIndex, ignoreErrors) {
  const page = await manager.getPage(pageIndex);
  await page.loadResources([
    'ColorSpace',
    'ExtGState',
    'Font',
    'Pattern',
    'Properties',
    'Shading',
    'XObject',
  ]);
  /** @type {ImageItem[]} */
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
    options: { ...page.evaluatorOptions, ignoreErrors },
  });
  // Remember each loaded font's metrics by the name setFont operators refer to.
  /** @type {Map<string, FontMetrics>} */
  const fonts = new Map();
  const handleSetFont = evaluator.handleSetFont;
  /** @param {any[]} args resources, fontArgs, fontRef, operatorList, task, state, ... */
  evaluator.handleSetFont = async function (...args) {
    const loadedName = await handleSetFont.apply(this, args),
      font = args[5]?.font;
    if (font)
      fonts.set(loadedName, {
        matrix: font.fontMatrix ?? [0.001, 0, 0, 0.001, 0, 0],
        vertical: !!font.vertical,
        defaultVMetrics: font.defaultVMetrics,
      });
    return loadedName;
  };
  /** @param {any} args */
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
  return { page, list, images, fonts };
}
// One walk over a page's operator list feeds the collectors named in `data.collect`:
// 'images' (inventory, or the decode of `data.decodeId`), 'overlay' (which images the page
// draws above) and 'rules' (ruling lines for table detection).
/**
 * @param {any} manager The worker's PDF manager.
 * @param {any} handler The worker's message handler.
 * @param {ScanRequest} data
 */
async function pdfextractScan(manager, handler, data) {
  const collect = new Set(data.collect ?? ['images']);
  const { page, list, images, fonts, degraded } = await pdfextractPage(
    manager,
    handler,
    data.pageIndex,
    collect.has('images'),
  );
  const inventory = collect.has('images') ? pdfextractImageCollector(images, data) : undefined,
    overlay = collect.has('overlay') ? pdfextractOverlayCollector() : undefined,
    rules = collect.has('rules') ? pdfextractRuleCollector() : undefined;
  pdfextractWalk(
    list,
    /** @type {Collector[]} */ ([inventory, overlay, rules].filter((collector) => collector)),
    fonts,
  );
  if (data.decodeId) {
    const target = inventory?.target();
    if (!target) throw new Error('IMAGE_NOT_FOUND: Image missing from page');
    try {
      return await pdfextractDecode(page, target, data);
    } finally {
      // An inline image's stream belongs to the cached operator list and keeps its decoded
      // samples: drop the cache so they are released (referenced images are fetched afresh).
      if (!target.item.image.dict.objId) pdfextractLastPage = undefined;
    }
  }
  /** @type {{ images?: RawImage[]; rules?: PageRules; degraded?: string }} */
  const result = {};
  if (inventory) {
    const overlaid = overlay?.result() ?? [];
    result.images = inventory.result().map((info, i) => ({ ...info, overlaid: !!overlaid[i] }));
    if (degraded !== undefined) result.degraded = degraded;
  }
  if (rules) result.rules = rules.result();
  return result;
}
/**
 * Switches a page's own renders (PDF.js's GetOperatorList for it) between the document's strict
 * options and lenient ones that skip broken operators, as viewers do. pdfextract renders
 * leniently (composites, full-page OCR) so a broken text operator does not leave the render
 * blank, while text extraction stays strict. Resolves once the page uses the requested options.
 * @param {any} manager
 * @param {{ pageIndex: number; lenient: boolean }} data
 */
async function pdfextractRenderMode(manager, { pageIndex, lenient }) {
  const page = await manager.getPage(pageIndex);
  if (lenient) {
    page.pdfextractStrictOptions ??= page.evaluatorOptions;
    page.evaluatorOptions = { ...page.pdfextractStrictOptions, ignoreErrors: true };
  } else if (page.pdfextractStrictOptions) {
    page.evaluatorOptions = page.pdfextractStrictOptions;
    page.pdfextractStrictOptions = undefined;
  }
  return true;
}
