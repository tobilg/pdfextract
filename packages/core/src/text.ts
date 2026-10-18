import type { Quad, TextSpan } from './contracts.js';
import type { Page } from './engine.js';
import { multiply, transformBox } from './geometry.js';

/** Native text spans of a page in canonical page points, from the PDF's text layer. */
export async function nativeSpans(
  page: Page,
  viewport: { transform: number[] },
): Promise<TextSpan[]> {
  const content = await page.getTextContent();
  const spans: TextSpan[] = [];
  for (const item of content.items) {
    if (!item.str) continue;
    const size =
      Math.hypot(item.transform[2], item.transform[3]) ||
      Math.hypot(item.transform[0], item.transform[1]) ||
      1;
    const style = content.styles[item.fontName] ?? {},
      ascent = style.ascent ?? 0.8,
      descent = style.descent ?? -0.2,
      width = item.width / size,
      m = multiply(viewport.transform, item.transform);
    spans.push({
      text: item.str,
      bbox: transformBox({ x: 0, y: descent, width, height: ascent - descent }, m),
      quad: corners(m, width, ascent, descent),
      source: 'native',
      fontName: style.fontFamily ?? item.fontName,
      fontSize: size * page.userUnit,
    });
  }
  return spans;
}
/** The span's corners (top-left, top-right, bottom-right, bottom-left) mapped by m. */
function corners(m: readonly number[], width: number, ascent: number, descent: number): Quad {
  const map = (x: number, y: number) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  return [
    ...map(0, ascent),
    ...map(width, ascent),
    ...map(width, descent),
    ...map(0, descent),
  ] as unknown as Quad;
}
