import type { PageRules } from './engine-types.js';

// Numbers per cached rule: x1, y1, x2, y2, width.
const FIELDS = 5;

/**
 * Ruling lines of scanned pages, stored compactly (one Float64Array per page) within a
 * document-wide budget of lines. When a page does not fit, the pages cached first are evicted;
 * an evicted page is simply scanned again when needed.
 */
export class RuleCache {
  private pages = new Map<number, { data: Float64Array; truncated: boolean }>();
  private size = 0;
  private readonly limit: number;
  /** @param maxLines Budget in ruling lines (PdfLimits.maxCachedRuleLines). */
  constructor(maxLines: number) {
    this.limit = maxLines * FIELDS;
  }
  get(pageIndex: number): PageRules | undefined {
    const entry = this.pages.get(pageIndex);
    if (!entry) return;
    const { data } = entry,
      rules: PageRules['rules'] = [];
    for (let i = 0; i < data.length; i += FIELDS)
      rules.push({
        x1: data[i],
        y1: data[i + 1],
        x2: data[i + 2],
        y2: data[i + 3],
        width: data[i + 4],
      });
    return { rules, truncated: entry.truncated };
  }
  set(pageIndex: number, { rules, truncated }: PageRules) {
    this.delete(pageIndex);
    const data = new Float64Array(rules.length * FIELDS);
    for (const [k, r] of rules.entries()) data.set([r.x1, r.y1, r.x2, r.y2, r.width], k * FIELDS);
    if (data.length > this.limit) return;
    for (const oldest of this.pages.keys()) {
      if (this.size + data.length <= this.limit) break;
      this.delete(oldest);
    }
    this.pages.set(pageIndex, { data, truncated });
    this.size += data.length;
  }
  clear() {
    this.pages.clear();
    this.size = 0;
  }
  /** Lines currently cached, for tests. */
  get cachedLines() {
    return this.size / FIELDS;
  }
  private delete(pageIndex: number) {
    const entry = this.pages.get(pageIndex);
    if (!entry) return;
    this.size -= entry.data.length;
    this.pages.delete(pageIndex);
  }
}
