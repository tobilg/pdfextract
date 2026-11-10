import { describe, expect, it } from 'vitest';
import type { TextSpan } from '../../packages/core/src/contracts.js';
import type { PageGlyphs, PageRules } from '../../packages/core/src/engine-types.js';
import { family, isTexPage, mathRuns, spliceMath } from '../../packages/core/src/math.js';

const HEIGHT = 792;
const viewport = { width: 612, transform: [1, 0, 0, -1, 0, HEIGHT] };
const FONTS = {
  R: 'CMR10',
  r: 'CMR7',
  M: 'CMMI10',
  m: 'CMMI7',
  S: 'CMSY10',
  s: 'CMSY7',
  X: 'CMEX10',
  B: 'MSBM10',
  A: 'TeX-matha10',
  U: 'STIXTwoMath-Regular',
};
type Font = keyof typeof FONTS;
/**
 * A glyph at page position (x, y) with y measured down from the top, as layout sees it; the
 * width follows from the text length unless given.
 */
const glyph = (
  text: string,
  font: Font,
  x: number,
  y: number,
  size = 10,
  code = -1,
  width = 0.5 * size,
) => ({
  text,
  code: code >= 0 ? code : (text.codePointAt(0) ?? 0),
  font,
  x0: x,
  x1: x + width,
  y: HEIGHT - y,
  size,
});
/** Glyphs set left to right from x, each 0.5 em wide (a word when given a string). */
const word = (text: string, font: Font, x: number, y: number, size = 10) =>
  [...text].map((c, i) => glyph(c, font, x + i * 0.5 * size, y, size));
const page = (...glyphs: ReturnType<typeof glyph>[][]): PageGlyphs => ({
  glyphs: glyphs.flat(),
  rules: [],
  fonts: Object.fromEntries(
    Object.entries(FONTS).map(([key, name]) => [key, { name, ascent: 0.75, descent: -0.25 }]),
  ),
});
// Body text elsewhere on the page sets the body size, as on a real page.
const body = () => word('Lorem ipsum dolor sit amet consectetur adipiscing', 'R', 72, 300);
const tex = (p: PageGlyphs, rules: PageRules['rules'] = []) =>
  mathRuns(p, rules, viewport).map((r) => r.tex);

describe('math: fonts', () => {
  it('MATH-01: TeX math fonts make a TeX page; text fonts and Symbol do not', () => {
    expect(family('ABCDEF+CMMI10')).toBe('CMMI');
    expect(family('LMMathItalic10-Regular')).toBe('LMMATHITALIC');
    expect(
      isTexPage({ a: { name: 'CMR10', bold: false }, b: { name: 'CMSY10', bold: false } }),
    ).toBe(true);
    expect(isTexPage({ a: { name: 'MSBM10', bold: false } })).toBe(true);
    expect(
      isTexPage({ a: { name: 'Times-Roman', bold: false }, b: { name: 'Symbol', bold: false } }),
    ).toBe(false);
  });
});

describe('math: LaTeX from glyphs', () => {
  it('MATH-02: sub- and superscripts follow from size and baseline', () => {
    // x_i^2 then y_{i,j}: subscripts below the baseline, the superscript above it.
    expect(
      tex(
        page(
          body(),
          [glyph('x', 'M', 100, 100), glyph('i', 'm', 105, 102, 7), glyph('2', 'r', 105, 96, 7)],
          [glyph('+', 'R', 112, 100), glyph('y', 'M', 122, 100)],
          [
            glyph('i', 'm', 127, 102, 7),
            glyph(',', 'm', 130, 102, 7),
            glyph('j', 'm', 132, 102, 7),
          ],
        ),
      ),
    ).toEqual(['x_{i}^{2}+y_{i,j}']);
  });
  it('MATH-03: TeX-encoded glyphs are read by code: ϵ and ε, the negation slash', () => {
    // cmmi codes 15 (ϵ) and 34 (ε), which PDF.js reports as ε and as the raw '"'; then a ≠ made
    // of cmsy's negation slash (code 54, shown as "6") over an equals sign.
    expect(
      tex(
        page(
          body(),
          [glyph('ε', 'M', 100, 100, 10, 15), glyph('1', 'r', 104, 102, 7)],
          [glyph('"', 'M', 150, 100, 10, 34), glyph('2', 'r', 154, 102, 7)],
          [
            glyph('a', 'M', 200, 100),
            glyph('6', 'S', 210, 100, 10, 54, 0),
            glyph('=', 'R', 210, 100),
          ],
          [glyph('b', 'M', 220, 100)],
        ),
      ),
    ).toEqual(['\\epsilon _{1}', '\\varepsilon _{2}', 'a\\neq b']);
  });
  it('MATH-04: a thin rule with parts centred above and below it is a fraction', () => {
    // TeX's rule is as wide as the wider part plus a little.
    const rule = { x1: 101.5, x2: 108.5, y1: HEIGHT - 97, y2: HEIGHT - 97, width: 0.4 };
    expect(
      tex(page(body(), [glyph('1', 'R', 102.5, 93)], [glyph('n', 'M', 102.5, 106)]), [rule]),
    ).toEqual(['\\frac{1}{n}']);
    // Words over and under a table's rule are not a fraction.
    const cell = { x1: 100, x2: 130, y1: HEIGHT - 97, y2: HEIGHT - 97, width: 0.4 };
    expect(
      tex(
        page(body(), word('Total', 'R', 102, 93), word('Mean', 'R', 104, 106), [
          glyph('x', 'M', 140, 106),
        ]),
        [cell],
      ),
    ).toEqual([]);
  });
  it('MATH-05: a raised marker after a word is a footnote, not a superscript', () => {
    // Kim∗ (a cmsy star raised after a roman word) stays text; Aut⁰(X) is a function, its
    // upright name an operator name.
    expect(tex(page(body(), word('Kim', 'R', 100, 100), [glyph('∗', 's', 115, 96, 7)]))).toEqual(
      [],
    );
    expect(
      tex(
        page(
          body(),
          word('Aut', 'R', 100, 100),
          [glyph('0', 'r', 115, 96, 7), glyph('(', 'R', 118.5, 100), glyph('X', 'M', 123.5, 100)],
          [glyph(')', 'R', 128.5, 100)],
        ),
      ),
    ).toEqual(['\\operatorname{Aut}^{0}(X)']);
  });
  it('MATH-06: limits centred below and above a large operator', () => {
    // Display ∑ (cmex code 88, 1.44 em wide) hangs from its origin above the baseline at
    // y=100; TeX sets the limits about 1.7 pt below and above it.
    expect(
      tex(
        page(
          body(),
          [glyph('∑', 'X', 100, 88, 10, 88, 14.4)],
          word('i=1', 'm', 101.9, 109, 7),
          [glyph('n', 'm', 105.5, 86, 7)],
          [glyph('x', 'M', 117, 100), glyph('i', 'm', 122, 102, 7)],
        ),
      ),
    ).toEqual(['\\sum_{i=1}^{n}x_{i}']);
  });
  it('MATH-07: blackboard bold, calligraphic and Greek glyphs; a lone symbol stays text', () => {
    expect(
      tex(
        page(
          body(),
          [
            glyph('C', 'S', 100, 100, 10, 67),
            glyph('⊂', 'S', 110, 100, 10, 26),
            glyph('F', 'B', 120, 100),
          ],
          [glyph('q', 'm', 125, 102, 7)],
          [glyph('±', 'S', 200, 100, 10, 6)],
        ),
      ),
    ).toEqual(['\\mathcal{C}\\subset \\mathbb{F}_{q}']);
  });
  it('MATH-09: mathabx glyphs are read by code, whatever text PDF.js gives them', () => {
    // An embedded TeX-matha10 names its codes as accents and letters: "p", "q" are its
    // parentheses (70, 71), "“" its equals sign (10), "ě" its ≥ (A5).
    expect(
      tex(
        page(body(), [
          glyph('p', 'A', 100, 100, 10, 0x70),
          glyph('x', 'M', 105, 100),
          glyph('q', 'A', 110, 100, 10, 0x71),
          glyph('“', 'A', 120, 100, 10, 0x10),
          glyph('y', 'M', 130, 100),
          glyph('ě', 'A', 140, 100, 10, 0xa5),
          glyph('0', 'R', 150, 100),
        ]),
      ),
    ).toEqual(['(x)=y\\geq 0']);
  });
  it('MATH-10: Unicode math letters are letters in their alphabet', () => {
    // unicode-math sets 𝑥 (italic), 𝐇 (bold) and ℝ (double-struck) from its math font.
    expect(
      tex(
        page(
          body(),
          [glyph('𝐇', 'U', 100, 100), glyph('𝑥', 'U', 110, 100), glyph('∈', 'U', 120, 100)],
          [glyph('ℝ', 'U', 130, 100), glyph('𝑛', 'U', 136, 96, 7)],
        ),
      ),
    ).toEqual(['\\mathbf{H}x\\in \\mathbb{R}^{n}']);
    expect(isTexPage({ a: { name: 'ABCDEF+STIXTwoMath-Regular', bold: false } })).toBe(true);
  });
  it('MATH-11: formulas of three glyphs or more are math without scripts; one glyph is not', () => {
    // τ(x) = g·τ(x): Greek, brackets and operators, no scripts; then a lone α.
    expect(
      tex(
        page(
          body(),
          [
            glyph('τ', 'M', 100, 100, 10, 28),
            glyph('(', 'R', 106, 100),
            glyph('x', 'M', 110, 100),
            glyph(')', 'R', 116, 100),
            glyph('=', 'R', 124, 100),
            glyph('g', 'M', 134, 100),
            glyph('·', 'S', 140, 100, 10, 1),
            glyph('x', 'M', 146, 100),
          ],
          [glyph('α', 'M', 200, 100, 10, 11)],
        ),
      ),
    ).toEqual(['\\tau (x)=g\\cdot x']);
  });
  it('MATH-12: operator names next to math join it, also through figures and brackets', () => {
    // 2 cos 2θ: the roman cos sits between roman figures, which join the math only once
    // the θ beside them does. Then diam(T): an upright word tight against a bracket of math.
    expect(
      tex(
        page(
          body(),
          [
            glyph('E', 'M', 100, 100),
            glyph('=', 'R', 110, 100),
            glyph('2', 'R', 120, 100),
            ...word('cos', 'R', 127, 100),
            glyph('2', 'R', 144, 100),
            glyph('θ', 'M', 149, 100, 10, 18),
          ],
          [
            glyph('h', 'M', 200, 100),
            glyph('T', 'm', 205, 102, 7),
            glyph('=', 'R', 212, 100),
            ...word('diam', 'R', 222, 100),
            glyph('(', 'R', 242, 100),
            glyph('T', 'M', 246, 100),
            glyph(')', 'R', 252, 100),
          ],
        ),
      ),
    ).toEqual(['E=2\\cos 2\\theta', 'h_{T}=\\operatorname{diam}(T)']);
  });
  it('MATH-14: upright letters with scripts and names set equal to math join it', () => {
    // T_p μ(0) with a roman T, then TOL = 10^{-6} with a roman name.
    expect(
      tex(
        page(
          body(),
          [
            glyph('T', 'R', 100, 100),
            glyph('p', 'm', 106, 102, 7),
            glyph('μ', 'M', 112, 100, 10, 22),
            glyph('(', 'R', 118, 100),
            glyph('0', 'R', 122, 100),
            glyph(')', 'R', 127, 100),
          ],
          [
            ...word('TOL', 'R', 200, 100),
            glyph('=', 'R', 218, 100),
            glyph('1', 'R', 226, 100),
            glyph('0', 'R', 231, 100),
            glyph('−', 's', 236, 96, 7, 0),
            glyph('6', 'r', 241, 96, 7),
          ],
        ),
      ),
    ).toEqual(['T_{p}\\mu (0)', '\\operatorname{TOL}=10^{-6}']);
  });
  it('MATH-13: a long arrow is a bar or equals sign joined to an arrow', () => {
    // x ⟶ y as TeX sets \\longrightarrow: cmsy's minus overlapping its arrow.
    expect(
      tex(
        page(body(), [
          glyph('x', 'M', 100, 100),
          glyph('−', 'S', 110, 100, 10, 0),
          glyph('→', 'S', 115, 100, 10, 33),
          glyph('y', 'M', 128, 100),
        ]),
      ),
    ).toEqual(['x\\longrightarrow y']);
  });
});

describe('math: splicing into text', () => {
  it('MATH-08: math replaces the glyphs it covers; text around it keeps its own spans', () => {
    // "where x_i = 2, and": a roman run, an italic x, a script i, and a roman run whose
    // "= 2" joins the math while ", and" stays text.
    const glyphs = page(
      body(),
      word('where', 'R', 50, 100),
      [glyph('x', 'M', 80, 100), glyph('i', 'm', 85, 102, 7)],
      [glyph('=', 'R', 92, 100), glyph('2', 'R', 101, 100), glyph(',', 'R', 106, 100)],
      word('and', 'R', 112, 100),
    );
    const span = (text: string, x0: number, x1: number, fontName: string, size = 10): TextSpan => ({
      text,
      bbox: { x: x0, y: 100 - 0.75 * size, width: x1 - x0, height: size },
      source: 'native',
      fontName,
      fontSize: size,
    });
    const native = [
      span('where', 50, 75, 'CMR10'),
      span('x', 80, 85, 'CMMI10'),
      span('i', 85, 88.5, 'CMMI7', 7),
      span('= 2, and', 92, 127, 'CMR10'),
    ];
    const out = spliceMath(native, glyphs, [], viewport);
    // The math span carries the word space before it.
    expect(out.map((s) => s.text)).toEqual(['where', ' $x_{i}=2$', ', and']);
    const [, math, rest] = out;
    expect(math.bbox).toEqual({ x: 80, y: 92.5, width: 26, height: 10 });
    expect(rest.bbox.x).toBe(106);
    expect(rest.fontName).toBe('CMR10');
  });
});
