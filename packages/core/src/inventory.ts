import type {
  Box,
  EmbeddedImage,
  ExtractionWarning,
  ImageOccurrence,
  OperationOptions,
} from './contracts.js';
import type { Engine, Page } from './engine.js';
import { checkAbort, PdfExtractError } from './errors.js';
import { intersects, multiply, orientationOf, transformBox } from './geometry.js';

/** Where an image's raster is decoded from. */
export interface ImageLocation {
  pageIndex: number;
  rawId: string;
}
/** Private per-occurrence render data: PDF-space CTM and index among identical draws. */
export interface Placement {
  matrix: number[];
  stack: number;
}

/** One image draw of a page: its asset's fields and the occurrence. */
interface PageDraw {
  asset: Omit<EmbeddedImage, 'occurrences'>;
  occurrence: ImageOccurrence;
}

/**
 * The document's image inventory, scanned once per page and only for the pages asked for.
 * Occurrences report `overlaid` for page content only; {@link ImageInventory.markAnnotated} adds
 * annotations.
 */
export class ImageInventory {
  private assets?: EmbeddedImage[];
  private draws = new Map<number, PageDraw[]>();
  /** Per page index: why its content could only be read leniently. */
  private degraded = new Map<number, ExtractionWarning>();
  private locations = new Map<string, ImageLocation>();
  private placements = new Map<string, Placement>();
  private annotationBoxes = new Map<number, Box[]>();
  constructor(
    private engine: Engine,
    private prefix: string,
  ) {}
  /**
   * Every image of the document, in page order; IDs and first occurrences match any order of
   * scans. Reports `images` progress for every page in `requested` (cached or not) and for any
   * other page scanned now to complete the document-wide inventory.
   */
  async collect(
    options: OperationOptions,
    signal: AbortSignal,
    requested: readonly number[] = [],
  ): Promise<EmbeddedImage[]> {
    const all = Array.from({ length: this.engine.doc.numPages }, (_, i) => i + 1),
      wanted = new Set(requested),
      reported = all.filter((p) => wanted.has(p) || !this.draws.has(p - 1));
    if (!this.assets) this.assets = await this.images(all, options, signal, reported);
    else this.report(reported, options);
    return this.assets;
  }
  /**
   * The images drawn on the given one-based pages (sorted), with only their occurrences on
   * those pages. Pages not scanned before are scanned now. Reports `images` progress for each
   * page in `reported` (by default all given pages, cached or not).
   */
  async images(
    pageNumbers: readonly number[],
    options: OperationOptions,
    signal: AbortSignal,
    reported: readonly number[] = pageNumbers,
  ): Promise<EmbeddedImage[]> {
    const assets = new Map<string, EmbeddedImage>(),
      report = new Set(reported);
    let completed = 0;
    for (const pageNumber of pageNumbers) {
      const draws = await this.page(pageNumber - 1, signal);
      for (const { asset, occurrence } of draws) {
        let entry = assets.get(asset.id);
        if (!entry) {
          entry = { ...asset, warnings: [...asset.warnings], occurrences: [] };
          assets.set(asset.id, entry);
        }
        entry.occurrences.push(occurrence);
      }
      if (report.has(pageNumber))
        options.onProgress?.({
          stage: 'images',
          completed: ++completed,
          total: report.size,
          unit: 'pages',
          pageNumber,
        });
    }
    return [...assets.values()];
  }
  /** `images` progress for pages whose inventory is already cached. */
  private report(pageNumbers: readonly number[], options: OperationOptions) {
    for (const [i, pageNumber] of pageNumbers.entries())
      options.onProgress?.({
        stage: 'images',
        completed: i + 1,
        total: pageNumbers.length,
        unit: 'pages',
        pageNumber,
      });
  }
  private async page(pageIndex: number, signal: AbortSignal): Promise<PageDraw[]> {
    const cached = this.draws.get(pageIndex);
    if (cached) return cached;
    checkAbort(signal);
    const page = await this.engine.doc.getPage(pageIndex + 1);
    const draws: PageDraw[] = [];
    try {
      const viewport = page.getViewport({ scale: 1 });
      const { images: raw, degraded } = await this.engine.inventory(pageIndex);
      if (degraded !== undefined)
        this.degraded.set(pageIndex, {
          code: 'IMAGE_INVENTORY_DEGRADED',
          message: `Page content has errors and was read leniently; images in the broken part may be missing: ${degraded}`,
          pageNumber: pageIndex + 1,
        });
      for (const [index, item] of raw.entries()) {
        const id = `${this.prefix}-${item.id}`;
        const imageToPage = multiply(multiply(viewport.transform, item.matrix), [
          1 / item.width,
          0,
          0,
          -1 / item.height,
          0,
          1,
        ]);
        const occurrenceId = `${id}-${pageIndex + 1}-${index}`;
        draws.push({
          asset: {
            id,
            width: item.width,
            height: item.height,
            bitsPerComponent: item.bitsPerComponent,
            colorSpace: item.colorSpace,
            hasAlpha: item.hasAlpha,
            warnings: item.unsupported
              ? [
                  {
                    code: 'UNSUPPORTED_IMAGE_FEATURE',
                    message: 'Image appearance depends on an unsupported graphics state',
                    imageId: id,
                  },
                ]
              : [],
          },
          occurrence: {
            occurrenceId,
            pageNumber: pageIndex + 1,
            imageToPage,
            bbox: transformBox({ x: 0, y: 0, width: item.width, height: item.height }, imageToPage),
            clipped: item.clipped,
            originalOrientation: orientationOf(imageToPage),
            overlaid: item.overlaid,
          },
        });
        this.placements.set(occurrenceId, { matrix: item.matrix, stack: item.stack });
        // Decode from the earliest page known to draw the image, whatever the scan order.
        const known = this.locations.get(id);
        if (!known || known.pageIndex > pageIndex)
          this.locations.set(id, { pageIndex, rawId: item.id });
      }
    } finally {
      page.cleanup();
    }
    this.draws.set(pageIndex, draws);
    return draws;
  }
  /** Warnings for scanned pages among the given one-based pages whose content had errors. */
  warnings(pageNumbers: readonly number[]): ExtractionWarning[] {
    return pageNumbers.flatMap((pageNumber) => {
      const warning = this.degraded.get(pageNumber - 1);
      return warning ? [{ ...warning }] : [];
    });
  }
  location(id: string): ImageLocation {
    const location = this.locations.get(id);
    if (!location)
      throw new PdfExtractError('IMAGE_NOT_FOUND', 'Unknown image ID', {
        context: { imageId: id },
      });
    return location;
  }
  placement(imageId: string, occurrenceId: string): Placement {
    const placement = this.placements.get(occurrenceId);
    if (!placement)
      throw new PdfExtractError('IMAGE_NOT_FOUND', 'Unknown image occurrence', {
        context: { imageId, occurrenceId },
      });
    return placement;
  }
  /** Bounds of annotations a viewer would draw on a page, in canonical page points; cached. */
  async annotations(pageNumber: number): Promise<Box[]> {
    const cached = this.annotationBoxes.get(pageNumber);
    if (cached) return cached;
    const page = await this.engine.doc.getPage(pageNumber);
    try {
      const boxes = await displayedAnnotations(page);
      this.annotationBoxes.set(pageNumber, boxes);
      return boxes;
    } finally {
      page.cleanup();
    }
  }
  /** Sets `overlaid` on (caller-owned copies of) occurrences that annotations cover. */
  async markAnnotated(images: EmbeddedImage[]): Promise<void> {
    for (const image of images)
      for (const occurrence of image.occurrences)
        if (
          !occurrence.overlaid &&
          (await this.annotations(occurrence.pageNumber)).some((a) =>
            intersects(a, occurrence.bbox),
          )
        )
          occurrence.overlaid = true;
  }
  clear() {
    this.assets = undefined;
    this.draws.clear();
    this.degraded.clear();
    this.locations.clear();
    this.placements.clear();
    this.annotationBoxes.clear();
  }
}
async function displayedAnnotations(page: Page): Promise<Box[]> {
  const viewport = page.getViewport({ scale: 1 });
  const annotations: { rect?: number[]; subtype?: string; annotationFlags?: number }[] =
    await page.getAnnotations({ intent: 'display' });
  return annotations
    .filter(
      (a) =>
        a.rect &&
        a.subtype !== 'Popup' &&
        a.subtype !== 'Link' &&
        // Hidden (2) and NoView (32) annotations are not displayed.
        !((a.annotationFlags ?? 0) & 34),
    )
    .map((a) => {
      const [x1, y1, x2, y2] = a.rect as number[];
      return transformBox({ x: x1, y: y1, width: x2 - x1, height: y2 - y1 }, viewport.transform);
    });
}
