import type { TextSpan } from './contracts.js';
import type { PageFonts, PageGlyphs, PageRules } from './engine-types.js';
import { transformBox } from './geometry.js';

/**
 * LaTeX from the glyphs of TeX-typeset pages, without a model.
 *
 * TeX sets math in its own fonts (Computer Modern math italic, symbols and extension, the AMS
 * and Latin Modern equivalents, tx/px, Euler, rsfs), so a glyph's font tells whether it is math
 * and what it means; glyphs of TeX-encoded fonts are read by character code through TeX's
 * fixed encodings (OML, OMS, OMX), since their names do not tell ϵ from ε. Sub- and superscripts
 * follow from glyph size and baseline, fractions, roots and overlines from the thin rules TeX
 * draws, accents from glyphs set above others. Only pages that use such a font are read; text
 * fonts there contribute digits, brackets, operators and operator names next to math glyphs.
 *
 * The approach follows liteparse's TeX math pass (run-llama/liteparse, Apache-2.0); this is an
 * independent implementation for PDF.js glyph data.
 */

type Role = 'mi' | 'sy' | 'bb' | 'ex' | 'frak' | 'scr' | 'cal';
type Encoding = 'oml' | 'oms' | 'omx' | 'abxa' | 'abxb' | 'abxx';

/** A glyph in the math pass, in page coordinates (y down). */
interface Glyph {
  /** Unicode text, or LaTeX when `tex` is set. */
  text: string;
  tex: boolean;
  role?: Role;
  encoding?: Encoding;
  family: string;
  font: string;
  size: number;
  /** Baseline y. */
  base: number;
  x0: number;
  x1: number;
  /** Estimated ink extent. */
  top: number;
  bottom: number;
  /** Font box extent: the box a text span of this glyph has. */
  boxTop: number;
  boxBottom: number;
  /** Accent commands opened before this glyph and closed after it. */
  pre: string;
  post: string;
  /** Indices of the page glyphs it stands for (several for a folded structure). */
  src: number[];
  /** A folded fraction, root or overline. */
  folded?: boolean;
  /** Alphabet of a Unicode math letter that no role carries. */
  style?: Style;
}
type Style = 'mathbf' | 'boldsymbol' | 'mathsf' | 'mathtt';

/** A run of math found on a page. */
export interface MathRun {
  tex: string;
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  size: number;
  /** Page glyph indices the run consumed. */
  glyphs: number[];
  /** A word space separates the run from the glyph before it on its line. */
  spaceBefore: boolean;
}

// ---------------------------------------------------------------------------------------------
// Fonts

/** Font family: no subset prefix, `-Regular` or size digits, upper case (CMMI10 → CMMI). */
export function family(name: string) {
  return name
    .replace(/^[A-Z]{6}\+/, '')
    .toUpperCase()
    .replace(/-REGULAR$/, '')
    .replace(/\d+$/, '');
}
/** The math role of a font family, and the TeX encoding its glyph codes follow. */
function fontRole(f: string): { role?: Role; encoding?: Encoding } {
  // tx/px/newtx families: a family prefix, then what the font holds.
  const tx = /^(?:R?TX|R?PX|NEWTX|NTX|ZX)(.*)$/.exec(f)?.[1];
  if (/^(CMMIB?|LMMATHITALIC|MLMMATHITALIC|CMBRMI)$/.test(f) || (tx && /^B?MI/.test(tx)))
    return { role: 'mi', encoding: 'oml' };
  if (/^(EURM|EURB|PAZOMATH-ITALIC)$/.test(f) || f.includes('MATHITALIC')) return { role: 'mi' };
  if (/^(CMB?SY|LMMATHSYMBOLS)$/.test(f) || (tx && /^B?SYS?$/.test(tx)))
    return { role: 'sy', encoding: 'oms' };
  if (/^(MSBM|BBOLD)$/.test(f) || /^(DSROM|BBM|PAZOMATHBLACKBOARDBOLD)/.test(f) || tx === 'SYB')
    return { role: 'bb' };
  if (
    /^(CMEX|LMMATHEXTENSION|EUEX|YHCMEX)$/.test(f) ||
    f.includes('EXTENSION') ||
    (tx && /^EXA?S?$/.test(tx))
  )
    return { role: 'ex', encoding: 'omx' };
  // mathabx (matha, mathb, mathx), also embedded as TeX-matha10 and the like.
  const abx = /^(?:TEX-)?MATH([ABX])$/.exec(f)?.[1];
  if (abx === 'X') return { role: 'ex', encoding: 'abxx' };
  if (abx) return { role: 'sy', encoding: abx === 'A' ? 'abxa' : 'abxb' };
  if (/^EUF[MB]$/.test(f)) return { role: 'frak' };
  if (/^(RSFS|STIXMATHSCRIPT)/.test(f)) return { role: 'scr' };
  if (/^EUS[MB]$/.test(f)) return { role: 'cal' };
  if (
    f === 'MSAM' ||
    (tx && /^SY[AC]$/.test(tx)) ||
    /^(LASY|WASY|STMARY|MNSYMBOL|ESINT|STIXMATH-REGULAR|TEX-MATH)/.test(f) ||
    SYMBOL_FAMILY.test(f) ||
    /SYMBOLS?-?$/.test(f)
  )
    return { role: 'sy' };
  // OpenType math fonts (STIX Two Math, Latin Modern Math, Libertinus Math, Cambria Math).
  if (UNICODE_MATH.test(f)) return { role: 'sy' };
  return {};
}
const UNICODE_MATH = /MATH/;
/**
 * The Symbol font (and its clones), where mathptmx and similar Times setups take Greek from:
 * its `phi` is TeX's \\phi though Unicode maps it to φ, and its `epsilon` TeX's \\epsilon.
 */
const SYMBOL_FAMILY = /^(STANDARDSYML|SYMBOL|PSYR|USYR)/;
const SYMBOL_GREEK: Record<string, string> = {
  φ: '\\phi',
  ϕ: '\\varphi',
  ε: '\\epsilon',
  ϑ: '\\vartheta',
};
/** Roman text faces of TeX: upright capital Greek is set in them. */
const TEXT_FAMILY = /^(CMR|CMBX|CMSL|CMTI|CMB|LMROMAN|R?TXR|R?PXR|NEWTXR)/;
/** Italic text faces: Times-based math setups (newtx, mathptmx) take math letters from them. */
const ITALIC_FAMILY = /ITAL|OBLIQUE|^CMTI|-IT$|-ITALIC/;
const BOLD_FAMILY = /^(CMBX|CMB)$/;

/**
 * Whether a page's fonts make it a TeX page: a math font in a TeX encoding, or an AMS, Euler or
 * rsfs alphabet. Word's Symbol font or a table's rules alone never make a page math.
 */
export function isTexPage(fonts: PageFonts) {
  return Object.values(fonts).some(({ name }) => {
    const f = family(name),
      { role, encoding } = fontRole(f);
    return (
      encoding !== undefined ||
      ['bb', 'frak', 'scr', 'cal'].includes(role ?? '') ||
      (role !== undefined && UNICODE_MATH.test(f))
    );
  });
}

// ---------------------------------------------------------------------------------------------
// TeX encodings: character code → LaTeX. Markers: NOT (negation slash), MAPSTO (↦ stem),
// SQRT (radical sign), ACC:<name> (accent), '' (a delimiter piece drawn with another).

const GREEK_COMMANDS =
  'Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi pi rho sigma tau upsilon phi chi psi omega varepsilon vartheta varpi varrho varsigma varphi'.split(
    ' ',
  );
const OML: Record<number, string> = {
  ...Object.fromEntries(GREEK_COMMANDS.map((name, code) => [code, `\\${name}`])),
  40: '\\leftharpoonup',
  41: '\\leftharpoondown',
  42: '\\rightharpoonup',
  43: '\\rightharpoondown',
  44: '',
  45: '',
  46: '\\triangleright',
  47: '\\triangleleft',
  63: '\\star',
  64: '\\partial',
  91: '\\flat',
  92: '\\natural',
  93: '\\sharp',
  94: '\\smile',
  95: '\\frown',
  96: '\\ell',
  123: '\\imath',
  124: '\\jmath',
  125: '\\wp',
  126: 'ACC:vec',
};
const OMS: Record<number, string> = Object.fromEntries(
  [
    '-',
    '\\cdot',
    '\\times',
    '\\ast',
    '\\div',
    '\\diamond',
    '\\pm',
    '\\mp',
    '\\oplus',
    '\\ominus',
    '\\otimes',
    '\\oslash',
    '\\odot',
    '\\bigcirc',
    '\\circ',
    '\\bullet',
    '\\asymp',
    '\\equiv',
    '\\subseteq',
    '\\supseteq',
    '\\leq',
    '\\geq',
    '\\preceq',
    '\\succeq',
    '\\sim',
    '\\approx',
    '\\subset',
    '\\supset',
    '\\ll',
    '\\gg',
    '\\prec',
    '\\succ',
    '\\leftarrow',
    '\\to',
    '\\uparrow',
    '\\downarrow',
    '\\leftrightarrow',
    '\\nearrow',
    '\\searrow',
    '\\simeq',
    '\\Leftarrow',
    '\\Rightarrow',
    '\\Uparrow',
    '\\Downarrow',
    '\\Leftrightarrow',
    '\\nwarrow',
    '\\swarrow',
    '\\propto',
    "'",
    '\\infty',
    '\\in',
    '\\ni',
    '\\bigtriangleup',
    '\\bigtriangledown',
    'NOT',
    'MAPSTO',
    '\\forall',
    '\\exists',
    '\\neg',
    '\\emptyset',
    '\\Re',
    '\\Im',
    '\\top',
    '\\perp',
    '\\aleph',
  ]
    .map((tex, code) => [code, tex] as [number, string])
    .concat(
      [
        '\\cup',
        '\\cap',
        '\\uplus',
        '\\wedge',
        '\\vee',
        '\\vdash',
        '\\dashv',
        '\\lfloor',
        '\\rfloor',
        '\\lceil',
        '\\rceil',
        '\\{',
        '\\}',
        '\\langle',
        '\\rangle',
        '|',
        '\\|',
        '\\updownarrow',
        '\\Updownarrow',
        '\\setminus',
        '\\wr',
        'SQRT',
        '\\amalg',
        '\\nabla',
        '\\int',
        '\\sqcup',
        '\\sqcap',
        '\\sqsubseteq',
        '\\sqsupseteq',
        '\\S',
        '\\dagger',
        '\\ddagger',
        '\\P',
        '\\clubsuit',
        '\\diamondsuit',
        '\\heartsuit',
        '\\spadesuit',
      ].map((tex, i) => [91 + i, tex] as [number, string]),
    ),
);
/** cmex: delimiters in four sizes, their pieces, big operators, wide accents, radicals. */
const OMX: Record<number, string> = (() => {
  const table: Record<number, string> = {};
  const delimiters = [
    '(',
    ')',
    '[',
    ']',
    '\\lfloor',
    '\\rfloor',
    '\\lceil',
    '\\rceil',
    '\\{',
    '\\}',
    '\\langle',
    '\\rangle',
  ];
  delimiters.forEach((d, i) => {
    table[i] = d;
  });
  Object.assign(table, { 12: '|', 13: '\\|', 14: '/', 15: '\\backslash' });
  ['(', ')'].forEach((d, i) => {
    table[16 + i] = d;
    table[18 + i] = d;
    table[32 + i] = d;
  });
  delimiters.slice(2).forEach((d, i) => {
    table[20 + i] = d;
    table[34 + i] = d;
  });
  Object.assign(table, { 30: '/', 31: '\\backslash', 44: '/', 45: '\\backslash' });
  Object.assign(table, { 46: '/', 47: '\\backslash' });
  // Pieces of tall delimiters: the top piece stands for the delimiter, the others are dropped.
  for (let code = 48; code <= 67; code++) table[code] = '';
  Object.assign(table, { 48: '(', 49: ')', 50: '[', 51: ']', 56: '\\{', 57: '\\}' });
  Object.assign(table, { 68: '\\langle', 69: '\\rangle' });
  const big = ['\\bigsqcup', '\\oint', '\\bigodot', '\\bigoplus', '\\bigotimes'];
  big.forEach((op, i) => {
    table[70 + 2 * i] = op;
    table[71 + 2 * i] = op;
  });
  const ops = [
    '\\sum',
    '\\prod',
    '\\int',
    '\\bigcup',
    '\\bigcap',
    '\\biguplus',
    '\\bigwedge',
    '\\bigvee',
  ];
  ops.forEach((op, i) => {
    table[80 + i] = op;
    table[88 + i] = op;
  });
  Object.assign(table, { 96: '\\coprod', 97: '\\coprod' });
  for (const code of [98, 99, 100]) table[code] = 'ACC:widehat';
  for (const code of [101, 102, 103]) table[code] = 'ACC:widetilde';
  delimiters.slice(2, 10).forEach((d, i) => {
    table[104 + i] = d;
  });
  for (let code = 112; code <= 116; code++) table[code] = 'SQRT';
  for (let code = 117; code <= 127; code++) table[code] = '';
  Object.assign(table, {
    120: '\\uparrow',
    121: '\\downarrow',
    126: '\\Uparrow',
    127: '\\Downarrow',
  });
  return table;
})();
/** A code table from `hex command` pairs. */
const codes = (pairs: string): Record<number, string> => {
  const table: Record<number, string> = {};
  const parts = pairs.split(' ');
  for (let i = 0; i + 1 < parts.length; i += 2) table[Number.parseInt(parts[i], 16)] = parts[i + 1];
  return table;
};
/**
 * mathabx's matha and mathb, by code (mathabx.dcl), with the commands KaTeX knows. Their
 * embedded fonts often name the codes as Latin accents and letters (`p` for a parenthesis), so
 * they are always read by code.
 */
const MATHA = codes(
  "00 + 01 - 02 \\times 03 \\div 04 \\cdot 05 \\circ 06 \\ast 08 \\pm 09 \\mp 0a \\ltimes 0b \\rtimes 0c \\diamond 0d \\bullet 0e \\star 10 = 11 \\equiv 12 \\sim 13 \\approx 14 \\simeq 15 \\cong 16 \\asymp 18 \\neq 1a \\nsim 1d \\ncong 20 \\neg 21 \\ll 22 \\gg 24 \\vdash 25 \\dashv 26 \\nvdash 28 \\vDash 2a \\nvDash 2c \\Vdash 2e \\nVdash 30 \\degree 31 ' 35 \\flat 36 \\natural 37 \\sharp 38 \\infty 39 \\propto 3a \\dagger 3b \\ddagger 3e \\amalg 40 \\forall 41 \\complement 42 \\partial 44 \\exists 45 \\nexists 46 \\Finv 47 \\Game 48 \\emptyset 4a \\top 4b \\bot 4e \\curlywedge 4f \\curlyvee 50 \\in 51 \\ni 52 \\notin 58 \\cap 59 \\cup 5a \\uplus 5b \\sqcap 5c \\sqcup 5e \\wedge 5f \\vee 60 \\oplus 61 \\ominus 62 \\otimes 64 \\odot 6d \\oslash 70 ( 71 ) 72 [ 73 ] 74 \\{ 75 \\} 76 \\llbracket 77 \\rrbracket 78 \\langle 79 \\rangle 7a \\setminus 7b / 7c | 7d \\| 7f NOT 80 \\subset 81 \\supset 84 \\subseteq 85 \\supseteq 86 \\nsubseteq 87 \\nsupseteq 88 \\subsetneq 89 \\supsetneq 8a \\varsubsetneq 8b \\varsupsetneq 8c \\subseteqq 8d \\supseteqq 8e \\nsubseteqq 8f \\nsupseteqq 90 \\subsetneqq 91 \\supsetneqq 92 \\varsubsetneqq 93 \\varsupsetneqq 94 \\Subset 95 \\Supset 98 \\triangleleft 99 \\triangleright 9a \\ntriangleleft 9b \\ntriangleright 9c \\trianglelefteq 9d \\trianglerighteq 9e \\ntrianglelefteq 9f \\ntrianglerighteq a0 < a1 > a2 \\nless a3 \\ngtr a4 \\leq a5 \\geq a6 \\nleq a7 \\ngeq ac \\lneq ad \\gneq ae \\leqq af \\geqq b0 \\nleqq b1 \\ngeqq b2 \\lneqq b3 \\gneqq b4 \\lvertneqq b5 \\gvertneqq b6 \\eqslantless b7 \\eqslantgtr ba \\lessgtr bb \\gtrless bc \\lesseqgtr bd \\gtreqless be \\lesseqqgtr bf \\gtreqqless c0 \\lesssim c1 \\gtrsim c4 \\lnsim c5 \\gnsim c6 \\lessapprox c7 \\gtrapprox ca \\lnapprox cb \\gnapprox cc \\lessdot cd \\gtrdot ce \\lll cf \\ggg d0 \\leftarrow d1 \\to d2 \\uparrow d3 \\downarrow d4 \\nwarrow d5 \\nearrow d6 \\swarrow d7 \\searrow d8 \\leftrightarrow d9 \\updownarrow da \\nleftarrow db \\nrightarrow dc \\nleftrightarrow de MAPSTO e0 \\leftharpoonup e1 \\rightharpoonup e2 \\leftharpoondown e3 \\rightharpoondown e4 \\upharpoonleft e5 \\downharpoonleft e6 \\upharpoonright e7 \\downharpoonright e8 \\leftrightharpoons e9 \\rightleftharpoons f0 \\Leftarrow f1 \\Rightarrow f2 \\Uparrow f3 \\Downarrow f4 \\Leftrightarrow f5 \\Updownarrow f6 \\nLeftarrow f7 \\nRightarrow f8 \\nLeftrightarrow",
);
const MATHB = codes(
  '00 \\dotplus 05 \\square 0b \\divideontimes 0e \\bigstar 13 \\risingdotseq 14 \\fallingdotseq 15 \\coloneqq 16 \\eqqcolon 1a \\circeq 1b \\eqcirc 1c \\triangleq 20 \\between 21 \\smile 22 \\frown 24 \\leftthreetimes 25 \\rightthreetimes 26 \\pitchfork 27 \\bowtie 2a \\nVDash 2c \\Vvdash 36 \\therefore 37 \\because 3d \\angle 3e \\measuredangle 3f \\sphericalangle 58 \\barwedge 59 \\veebar 5a \\doublebarwedge 5c \\doublecap 5d \\doublecup 60 \\boxplus 61 \\boxminus 62 \\boxtimes 64 \\boxdot 70 \\lgroup 71 \\rgroup 72 \\lceil 73 \\rceil 74 \\lfloor 75 \\rfloor 78 \\ulcorner 79 \\urcorner 7a \\llcorner 7b \\lrcorner 80 \\sqsubset 81 \\sqsupset 84 \\sqsubseteq 85 \\sqsupseteq 9d \\blacktriangledown 9e \\blacktriangleleft 9f \\blacktriangleright a0 \\prec a1 \\succ a2 \\nprec a3 \\nsucc a4 \\preccurlyeq a5 \\succcurlyeq a8 \\preceq a9 \\succeq aa \\npreceq ab \\nsucceq b6 \\curlyeqprec b7 \\curlyeqsucc c0 \\precsim c1 \\succsim c4 \\precnsim c5 \\succnsim c6 \\precapprox c7 \\succapprox ca \\precnapprox cb \\succnapprox d0 \\leftleftarrows d1 \\rightrightarrows d2 \\upuparrows d3 \\downdownarrows d4 \\leftrightarrows d5 \\rightleftarrows e4 \\diagup e5 \\diagdown e8 \\Lsh e9 \\Rsh ec \\looparrowleft ed \\looparrowright f0 \\curvearrowleft f1 \\curvearrowright f6 \\circlearrowleft f7 \\circlearrowright f9 \\rightsquigarrow fa \\leftrightsquigarrow',
);
/**
 * mathabx's mathx (mathxdrv.mf): delimiters in blocks of four sizes and three pieces, radicals,
 * wide accents, big operators in two sizes.
 */
const MATHX: Record<number, string> = (() => {
  const table: Record<number, string> = {};
  const blocks: [number, string][] = [
    [0x00, '('],
    [0x08, ')'],
    [0x10, '['],
    [0x18, ']'],
    [0x20, '\\{'],
    [0x28, '\\}'],
    [0x30, '\\llbracket'],
    [0x38, '\\rrbracket'],
  ];
  // Four sizes, then the top piece (standing for the delimiter) and pieces drawn with it.
  for (const [start, d] of blocks) {
    for (let k = 0; k < 5; k++) table[start + k] = d;
    for (let k = 5; k < 8; k++) table[start + k] = '';
  }
  Object.assign(table, { 7: '|', 15: '\\|', 23: '', 31: '|', 55: '', 63: '' });
  const sized: [number, string][] = [
    [0x40, '\\langle'],
    [0x44, '\\rangle'],
    [0x48, '\\backslash'],
    [0x4c, '/'],
    [0x50, '\\lceil'],
    [0x54, '\\rceil'],
    [0x58, '\\lfloor'],
    [0x5c, '\\rfloor'],
  ];
  for (const [start, d] of sized) for (let k = 0; k < 4; k++) table[start + k] = d;
  for (let code = 0x60; code <= 0x64; code++) table[code] = 'SQRT';
  for (let code = 0x65; code <= 0x6f; code++) table[code] = '';
  // Wide accents: one of each at 70-75, then four wider of each from 78 on.
  const accents = ['widehat', 'widecheck', 'widetilde', 'overline', 'overrightarrow'];
  accents.forEach((name, i) => {
    table[0x70 + i] = `ACC:${name}`;
    for (let k = 0; k < 4; k++) table[0x78 + 4 * i + k] = `ACC:${name}`;
  });
  Object.assign(table, { 117: '', 140: '', 141: '', 142: '', 143: '' });
  Object.assign(table, { 118: '\\lgroup', 119: '\\rgroup' });
  const big: [number, string][] = [
    [0x93, '\\bigcap'],
    [0x94, '\\bigcup'],
    [0x95, '\\biguplus'],
    [0x97, '\\bigsqcup'],
    [0x99, '\\bigwedge'],
    [0x9a, '\\bigvee'],
    [0xb0, '\\sum'],
    [0xb1, '\\prod'],
    [0xb2, '\\coprod'],
    [0xb3, '\\int'],
    [0xb4, '\\iint'],
    [0xb5, '\\iiint'],
    [0xb6, '\\oint'],
    [0xb7, '\\oiint'],
    [0xc0, '\\bigoplus'],
    [0xc2, '\\bigotimes'],
    [0xc4, '\\bigodot'],
  ];
  // Text and display sizes: 90-9C and A0-AC, B0-B7 and B8-BF, C0-CF and E0-EF.
  for (const [code, op] of big) {
    table[code] = op;
    table[code + (code >= 0xc0 ? 0x20 : code >= 0xb0 ? 8 : 0x10)] = op;
  }
  Object.assign(table, { 157: '\\uparrow', 158: '', 159: '', 173: '\\Uparrow', 174: '', 175: '' });
  return table;
})();
const TABLES: Record<Encoding, Record<number, string>> = {
  oml: OML,
  oms: OMS,
  omx: OMX,
  abxa: MATHA,
  abxb: MATHB,
  abxx: MATHX,
};
/** Encodings whose fonts are read by code whatever text PDF.js gives their glyphs. */
const BY_CODE = new Set<Encoding>(['abxa', 'abxb', 'abxx']);

const GREEK: Record<string, string> = {
  α: 'alpha',
  β: 'beta',
  γ: 'gamma',
  δ: 'delta',
  ϵ: 'epsilon',
  ε: 'varepsilon',
  ζ: 'zeta',
  η: 'eta',
  θ: 'theta',
  ϑ: 'vartheta',
  ι: 'iota',
  κ: 'kappa',
  λ: 'lambda',
  µ: 'mu',
  μ: 'mu',
  ν: 'nu',
  ǫ: 'epsilon',
  ξ: 'xi',
  π: 'pi',
  ϖ: 'varpi',
  ρ: 'rho',
  ϱ: 'varrho',
  σ: 'sigma',
  ς: 'varsigma',
  τ: 'tau',
  υ: 'upsilon',
  ϕ: 'phi',
  φ: 'varphi',
  χ: 'chi',
  ψ: 'psi',
  ω: 'omega',
  Γ: 'Gamma',
  Δ: 'Delta',
  '∆': 'Delta',
  Θ: 'Theta',
  Λ: 'Lambda',
  Ξ: 'Xi',
  Π: 'Pi',
  Σ: 'Sigma',
  Υ: 'Upsilon',
  Φ: 'Phi',
  Ψ: 'Psi',
  Ω: 'Omega',
  '\u2126': 'Omega',
};
const SYMBOLS: Record<string, string> = {
  '∈': '\\in',
  '∉': '\\notin',
  '∋': '\\ni',
  '≤': '\\leq',
  '⩽': '\\leq',
  '≥': '\\geq',
  '⩾': '\\geq',
  '≠': '\\neq',
  '≈': '\\approx',
  '∼': '\\sim',
  '≃': '\\simeq',
  '≅': '\\cong',
  '≡': '\\equiv',
  '≍': '\\asymp',
  '∝': '\\propto',
  '≪': '\\ll',
  '≫': '\\gg',
  '⊂': '\\subset',
  '⊆': '\\subseteq',
  '⊊': '\\subsetneq',
  '⊃': '\\supset',
  '⊇': '\\supseteq',
  '⊑': '\\sqsubseteq',
  '⊒': '\\sqsupseteq',
  '∪': '\\cup',
  '∩': '\\cap',
  '⊔': '\\sqcup',
  '⊓': '\\sqcap',
  '⊎': '\\uplus',
  '∞': '\\infty',
  '∂': '\\partial',
  '∇': '\\nabla',
  '±': '\\pm',
  '∓': '\\mp',
  '×': '\\times',
  '·': '\\cdot',
  '⋅': '\\cdot',
  '÷': '\\div',
  '∗': '\\ast',
  '◦': '\\circ',
  '∘': '\\circ',
  '•': '\\bullet',
  '∙': '\\bullet',
  '→': '\\to',
  '←': '\\leftarrow',
  '↔': '\\leftrightarrow',
  '↑': '\\uparrow',
  '↓': '\\downarrow',
  '⇒': '\\Rightarrow',
  '⇐': '\\Leftarrow',
  '⇔': '\\Leftrightarrow',
  '↦': '\\mapsto',
  '↪': '\\hookrightarrow',
  '⟶': '\\longrightarrow',
  '⟹': '\\Longrightarrow',
  '⇀': '\\rightharpoonup',
  '∀': '\\forall',
  '∃': '\\exists',
  '¬': '\\neg',
  '∧': '\\wedge',
  '∨': '\\vee',
  '∅': '\\emptyset',
  '∑': '\\sum',
  '∏': '\\prod',
  '∐': '\\coprod',
  '∫': '\\int',
  '∬': '\\iint',
  '∮': '\\oint',
  '⋃': '\\bigcup',
  '⋂': '\\bigcap',
  '⊗': '\\otimes',
  '⊕': '\\oplus',
  '⊖': '\\ominus',
  '⊙': '\\odot',
  '⊘': '\\oslash',
  '∥': '\\|',
  '‖': '\\|',
  '∣': '\\mid',
  '∤': '\\nmid',
  '⟨': '\\langle',
  '〈': '\\langle',
  '⟩': '\\rangle',
  '〉': '\\rangle',
  '⌊': '\\lfloor',
  '⌋': '\\rfloor',
  '⌈': '\\lceil',
  '⌉': '\\rceil',
  '…': '\\ldots',
  '⋯': '\\cdots',
  '−': '-',
  '′': "'",
  '″': "''",
  '{': '\\{',
  '}': '\\}',
  '∖': '\\setminus',
  '\\': '\\setminus',
  '†': '\\dagger',
  '‡': '\\ddagger',
  '⊤': '\\top',
  '⊥': '\\perp',
  '⊢': '\\vdash',
  '⊣': '\\dashv',
  '⊨': '\\models',
  ℓ: '\\ell',
  ℏ: '\\hbar',
  ℵ: '\\aleph',
  ℜ: '\\Re',
  ℑ: '\\Im',
  ℘: '\\wp',
  ı: '\\imath',
  ȷ: '\\jmath',
  '≺': '\\prec',
  '≻': '\\succ',
  '⪯': '\\preceq',
  '≼': '\\preceq',
  '⪰': '\\succeq',
  '#': '\\#',
  '♯': '\\sharp',
  '%': '\\%',
  '&': '\\&',
  _: '\\_',
  $: '\\$',
  '√': 'SQRT',
  ℝ: '\\mathbb{R}',
  ℕ: '\\mathbb{N}',
  ℤ: '\\mathbb{Z}',
  ℚ: '\\mathbb{Q}',
  ℂ: '\\mathbb{C}',
  '≜': '\\triangleq',
  '≔': ':=',
  '⋆': '\\star',
  '⋄': '\\diamond',
  '□': '\\square',
  '△': '\\triangle',
  '∠': '\\angle',
  '\u0338': 'NOT',
  // Pieces of tall delimiters (Adobe's private-use code points).
  '\uf8eb': '(',
  '\uf8ee': '[',
  '\uf8f1': '\\{',
  '\uf8f6': ')',
  '\uf8f9': ']',
  '\uf8fc': '\\}',
  ...Object.fromEntries(
    [
      ...'\uf8ec\uf8ed\uf8ef\uf8f0\uf8f2\uf8f3\uf8f4\uf8f5\uf8f7\uf8f8\uf8fa\uf8fb\uf8fd\uf8fe\uf8e5',
    ].map((c) => [c, '']),
  ),
};
/** The character a decoded command stands for, to estimate its ink. */
const CHARACTER: Record<string, string> = {
  ...Object.fromEntries(Object.entries(GREEK).map(([char, name]) => [`\\${name}`, char])),
  '\\epsilon': 'ϵ',
  '\\varepsilon': 'ε',
  '\\phi': 'ϕ',
  '\\varphi': 'φ',
  '\\ell': 'l',
  '\\partial': 'd',
  '\\imath': 'ı',
  '\\jmath': 'j',
};
/** In an extension font, an operator symbol is the large one. */
const LARGE: Record<string, string> = {
  '⊕': '\\bigoplus',
  '⊗': '\\bigotimes',
  '⊙': '\\bigodot',
  '∪': '\\bigcup',
  '⋃': '\\bigcup',
  '∩': '\\bigcap',
  '⋂': '\\bigcap',
  '∧': '\\bigwedge',
  '⋀': '\\bigwedge',
  '∨': '\\bigvee',
  '⋁': '\\bigvee',
  '⊔': '\\bigsqcup',
  '⊎': '\\biguplus',
};
const ACCENTS: Record<string, string> = {
  ˆ: 'hat',
  '^': 'hat',
  '˜': 'tilde',
  '~': 'tilde',
  '¯': 'bar',
  '˙': 'dot',
  '¨': 'ddot',
  '´': 'acute',
  '`': 'grave',
  ˇ: 'check',
  '˘': 'breve',
  '\u20d7': 'vec',
  '\u0300': 'grave',
  '\u0301': 'acute',
  '\u0302': 'hat',
  '\u0303': 'tilde',
  '\u0304': 'bar',
  '\u0305': 'bar',
  '\u0306': 'breve',
  '\u0307': 'dot',
  '\u0308': 'ddot',
  '\u030c': 'check',
};
/** Operators LaTeX (and KaTeX) has a command for. */
const OPERATOR_COMMANDS = new Set(
  'sin cos tan cot sec csc log ln lg exp max min arg lim det sup inf ker dim deg mod sinh cosh tanh coth arcsin arccos arctan liminf limsup Pr gcd hom'.split(
    ' ',
  ),
);
/** Operator names set upright next to math, written as \operatorname. */
const OPERATORS = new Set([
  ...OPERATOR_COMMANDS,
  ...'tr Tr diag rank span Span sgn sign Re Im Hom End Aut Ext Tor Ker Coker Im id Id conv supp Supp diam dist ord Pic Spec Gal codim vol Var Cov div curl grad Res lcm Lip Sym Stab Fix GL SL PSL SO SU Gr'.split(
    ' ',
  ),
]);
/** Text-font characters that join math next to them. */
const MATH_TEXT = new Set([..."0123456789()[]{}=+-−,;:!/|.'<>*′"]);
const MARKS =
  /[_^]|\\(frac|sqrt|overline|mathbb|mathcal|mathfrak|mathscr|hat|tilde|bar|dot|ddot|acute|grave|check|breve|vec|widehat|widetilde)\b/;

const alpha = (t: string) => /^\p{L}+$/u.test(t);
const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b),
    mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const maxSize = (gs: readonly Glyph[]) => Math.max(...gs.map((g) => g.size));
const center = (g: Glyph) => (g.x0 + g.x1) / 2;
const byX = (a: Glyph, b: Glyph) => a.x0 - b.x0;

/** Estimated ink extent of a glyph in em above the baseline: [top, bottom]. */
function ink(g: { text: string; tex: boolean; role?: Role }): [number, number] {
  // LaTeX of a decoded glyph: classified by the character it stands for.
  const t = g.tex ? (CHARACTER[g.text] ?? g.text) : g.text;
  // Accents first: wide ones come from the extension font but sit on the baseline.
  if ((g.tex && t.startsWith('ACC:')) || ACCENTS[t]) return [0.72, 0.5];
  if (g.role === 'ex' || t === 'SQRT') return [0.04, -1.1];
  if (/^[acemnorsuvwxzıαεικνοπστυωϵǫϖ]$/u.test(t)) return [0.45, 0];
  if (/^[gjpqyγημρφχψςϱ]$/u.test(t)) return [0.45, -0.2];
  if (/^[βζξfϕ]$/u.test(t)) return [0.7, -0.2];
  if (/^[()[\]{}|‖⟨⟩〈〉⌊⌋⌈⌉]$/u.test(t) || /^\\[lr](angle|floor|ceil)|^\\[{}|]$/.test(t))
    return [0.75, -0.25];
  if (/^[+−\-=<>≤≥∼≈≡∈∉⊂⊆⊃⊇→←⇒×·±∓⊕⊗∪∩∧∨]$/u.test(t)) return [0.58, -0.08];
  if (/^[.,]$/.test(t)) return [0.1, -0.2];
  if (/^['′∗*]$/u.test(t)) return [0.75, 0.3];
  return [0.7, 0];
}

/** Whether a TeX-encoded font's codes match its encoding table (re-encoded fonts do not). */
function encodingAgrees(
  page: PageGlyphs,
  loaded: string,
  encoding: Encoding,
  cache: Map<string, boolean>,
) {
  let agrees = cache.get(loaded);
  if (agrees !== undefined) return agrees;
  let yes = 0,
    no = 0;
  const canonical = (s: string) => s.replace(/^\\var/, '\\').replace(/^\\(big)/, '\\');
  for (const g of page.glyphs) {
    if (g.font !== loaded || g.code < 0) continue;
    const expected = TABLES[encoding][g.code];
    const actual = GREEK[g.text] ? `\\${GREEK[g.text]}` : (SYMBOLS[g.text] ?? LARGE[g.text]);
    if (!expected || !actual || actual === 'SQRT') continue;
    if (canonical(expected) === canonical(actual)) yes++;
    else no++;
  }
  agrees = no <= yes;
  cache.set(loaded, agrees);
  return agrees;
}

/**
 * A Unicode math letter or digit (𝑥, 𝐀, 𝛼, 𝔤, ℝ) as its plain character and alphabet: unicode-math
 * and newtx set math in these, and LaTeX writes them as letters in an alphabet command.
 */
function mathAlphanumeric(text: string): { text: string; role: Role; style?: Style } | undefined {
  const cp = text.codePointAt(0) ?? 0;
  if (
    text.length > 2 ||
    !((cp >= 0x1d400 && cp <= 0x1d7ff) || /^[ℂℍℕℙℚℝℤℬℰℱℋℐℒℳℛℭℌℨℎ]$/u.test(text))
  )
    return undefined;
  const plain = text.normalize('NFKD');
  if (!/^[\p{L}\p{N}]$/u.test(plain)) return undefined;
  if (cp < 0x1d400) {
    if (/^[ℂℍℕℙℚℝℤ]$/u.test(text)) return { text: plain, role: 'bb' };
    if (/^[ℭℌℨ]$/u.test(text)) return { text: plain, role: 'frak' };
    return { text: plain, role: /^[ℬℰℱℋℐℒℳℛ]$/u.test(text) ? 'cal' : 'mi' };
  }
  // Latin alphabets of 52 letters from U+1D400, dotless i and j, Greek alphabets of 58 from
  // U+1D6A8, digit sets of 10 from U+1D7CE.
  const latin = [
    'mathbf',
    '',
    'boldsymbol',
    'cal',
    'cal',
    'frak',
    'bb',
    'frak',
    'mathsf',
    'mathsf',
  ];
  let kind: string;
  if (cp < 0x1d6a4)
    kind = [...latin, 'mathsf', 'mathsf', 'mathtt'][Math.floor((cp - 0x1d400) / 52)];
  else if (cp < 0x1d6a8) kind = '';
  else if (cp < 0x1d7ca)
    kind = ['boldsymbol', '', 'boldsymbol', 'boldsymbol', 'boldsymbol'][
      Math.floor((cp - 0x1d6a8) / 58)
    ];
  else if (cp < 0x1d7ce) kind = 'boldsymbol';
  else kind = ['mathbf', 'bb', 'mathsf', 'mathsf', 'mathtt'][Math.floor((cp - 0x1d7ce) / 10)];
  if (kind === 'bb' || kind === 'frak') return { text: plain, role: kind };
  // \mathcal has capitals only: a script small letter is a letter.
  if (kind === 'cal') return { text: plain, role: /^[A-Z]$/.test(plain) ? 'cal' : 'mi' };
  return { text: plain, role: 'mi', ...(kind ? { style: kind as Style } : {}) };
}

/** Page glyphs as math-pass glyphs in page coordinates (y down), or none when not upright. */
function glyphs(page: PageGlyphs, transform: number[]): Glyph[] {
  const [a, b, c, d, e, f] = transform;
  if (!(a > 0 && d < 0 && Math.abs(b) < 1e-9 && Math.abs(c) < 1e-9)) return [];
  const roles = new Map<string, { role?: Role; encoding?: Encoding; family: string }>(),
    agreement = new Map<string, boolean>();
  const out: Glyph[] = [];
  page.glyphs.forEach((raw, index) => {
    const font = page.fonts[raw.font];
    let info = roles.get(raw.font);
    if (!info) {
      const fam = family(font?.name ?? '');
      info = { ...fontRole(fam), family: fam };
      roles.set(raw.font, info);
    }
    let text = raw.text,
      tex = false,
      role = info.role,
      style: Style | undefined;
    const letter = mathAlphanumeric(raw.text);
    // TeX-encoded fonts read by code, except for the letters of math italic and symbol fonts
    // (calligraphic capitals in the latter), and the punctuation cmmi draws as itself.
    const encoding = info.encoding;
    if (letter) {
      ({ text, role, style } = letter);
    } else if (encoding && BY_CODE.has(encoding) && raw.code >= 0) {
      const decoded = TABLES[encoding][raw.code];
      if (decoded === '') return;
      if (decoded !== undefined) {
        text = decoded;
        tex = true;
      }
    } else if (encoding && raw.code >= 0 && (encoding === 'omx' || !/^[A-Za-z]$/.test(raw.text))) {
      const decoded = TABLES[encoding][raw.code];
      const plain = encoding === 'oml' && /^[0-9.,<>/]$/.test(String.fromCharCode(raw.code));
      if (
        decoded !== undefined &&
        !plain &&
        (encodingAgrees(page, raw.font, encoding, agreement) ||
          raw.text === String.fromCharCode(raw.code))
      ) {
        if (decoded === '') return;
        text = decoded;
        tex = true;
      }
    }
    if (!tex && SYMBOL_FAMILY.test(info.family) && SYMBOL_GREEK[text]) {
      text = SYMBOL_GREEK[text];
      tex = true;
    }
    if (!tex && role === 'ex' && LARGE[text]) {
      text = LARGE[text];
      tex = true;
    }
    if (!role && TEXT_FAMILY.test(info.family) && GREEK[text]) role = 'mi';
    const x0 = a * raw.x0 + e,
      x1 = a * raw.x1 + e,
      base = d * raw.y + f,
      size = raw.size * Math.abs(d);
    const ascent = Number.isFinite(font?.ascent) && font.ascent > 0 ? font.ascent : 0.78,
      descent = Number.isFinite(font?.descent) && font.descent < 0 ? font.descent : -0.22;
    const [inkTop, inkBottom] = ink({ text, tex, role });
    // Extension glyphs hang from their origin about as deep as they are wide (a display ∑ is
    // 1.44 em wide and 1.45 em deep, a text one 1.06 by 1.0).
    const hangs = role === 'ex' && !(tex && text.startsWith('ACC:')),
      depth = hangs ? Math.max(-inkBottom * size, Math.abs(x1 - x0)) : -inkBottom * size;
    out.push({
      text,
      tex,
      role,
      encoding,
      family: info.family,
      font: font?.name ?? '',
      size,
      base,
      x0: Math.min(x0, x1),
      x1: Math.max(x0, x1),
      top: base - inkTop * size,
      bottom: base + depth,
      boxTop: base - ascent * size,
      boxBottom: base - descent * size,
      pre: '',
      post: '',
      src: [index],
      ...(style ? { style } : {}),
    });
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// LaTeX of glyphs

function accentOf(g: Glyph): string | undefined {
  if (g.tex && g.text.startsWith('ACC:')) return g.text.slice(4);
  if (g.tex || !ACCENTS[g.text]) return undefined;
  // Text-font accents; in a math italic font only the ones TeX takes from it.
  if (!g.role || (g.role === 'mi' && '˜¯˙¨ˆ\u20d7'.includes(g.text))) return ACCENTS[g.text];
  return undefined;
}
/** Removes accent glyphs from a run, wrapping the glyph (or glyphs, for wide accents) under each. */
function attachAccents(run: Glyph[]): Glyph[] {
  const accents = run.filter((g) => accentOf(g) !== undefined);
  if (!accents.length) return run;
  const rest = run.filter((g) => accentOf(g) === undefined);
  for (const a of accents) {
    const name = accentOf(a) as string,
      cx = center(a),
      wide = name.startsWith('wide');
    let under: Glyph[];
    if (wide) {
      const largest = rest.length ? maxSize(rest) : 0;
      under = rest.filter(
        (g) =>
          g.top > a.top &&
          a.x0 - 0.1 * a.size <= center(g) &&
          center(g) <= a.x1 + 0.1 * a.size &&
          g.size >= 0.9 * largest,
      );
    } else {
      const below = rest.filter(
        (g) =>
          g.top > a.top + 0.1 * a.size && g.x0 - 0.15 * a.size <= cx && cx <= g.x1 + 0.15 * a.size,
      );
      const nearest = below.reduce<Glyph | undefined>(
        (best, g) => (!best || Math.abs(center(g) - cx) < Math.abs(center(best) - cx) ? g : best),
        undefined,
      );
      under = nearest ? [nearest] : [];
    }
    if (!under.length) continue;
    under.sort(byX);
    under[0].pre += `\\${name}{`;
    under[under.length - 1].post = `}${under[under.length - 1].post}`;
  }
  return rest;
}
/** A command followed by a space when it ends in a letter, so the next token stays separate. */
const command = (s: string) => (/^\\[a-zA-Z]+$/.test(s) ? `${s} ` : s);
function glyphTex(g: Glyph): string {
  const t = g.text;
  let inner: string;
  if (g.tex) inner = command(t);
  else if (g.role === 'bb' && alpha(t)) inner = `\\mathbb{${t.toUpperCase()}}`;
  else if (!g.role && BOLD_FAMILY.test(g.family) && /^[A-Za-z]$/.test(t)) inner = `\\mathbf{${t}}`;
  else if (g.role === 'frak' && alpha(t)) inner = `\\mathfrak{${t}}`;
  else if (g.role === 'scr' && alpha(t)) inner = `\\mathscr{${t}}`;
  else if (g.role === 'cal' && /^[A-Z]$/.test(t)) inner = `\\mathcal{${t}}`;
  else if (g.encoding === 'oms' && /^[A-Z]$/.test(t)) inner = `\\mathcal{${t}}`;
  else if (GREEK[t]) inner = `\\${GREEK[t]} `;
  else if (SYMBOLS[t] !== undefined) inner = command(SYMBOLS[t]);
  else inner = t;
  if (g.style) inner = `\\${g.style}{${inner.trimEnd()}}`;
  return g.pre + inner + g.post;
}
/** A script's script back on the baseline still counts as on it (the l of ‖g‖_{C^l}). */
const onBase = (g: Glyph, base: number, size: number) =>
  g.size >= 0.92 * size || (Math.abs(g.base - base) <= 0.12 * size && g.size >= 0.8 * size);

/** LaTeX of glyphs (sorted by x) on baseline `base` at `size`, scripts recursively. */
function build(gs: Glyph[], base: number, size: number): string {
  let out = '';
  for (let i = 0; i < gs.length; ) {
    const g = gs[i];
    if (onBase(g, base, size)) {
      if (!g.role && !g.tex && alpha(g.text)) {
        let j = i;
        while (
          j < gs.length &&
          !gs[j].role &&
          !gs[j].tex &&
          alpha(gs[j].text) &&
          onBase(gs[j], base, size)
        )
          j++;
        const word = gs
          .slice(i, j)
          .map((x) => x.text)
          .join('');
        // Upright words in math are operator names (\\cos, \\operatorname{Hom}) or text.
        if (OPERATORS.has(word) || (j - i >= 2 && !ITALIC_FAMILY.test(g.family))) {
          out += OPERATOR_COMMANDS.has(word) ? `\\${word} ` : `\\operatorname{${word}}`;
          i = j;
          continue;
        }
      }
      out += glyphTex(g);
      i++;
      continue;
    }
    // A script run: consecutive glyphs off the baseline. First-level glyphs go up or down by
    // their baseline; smaller ones ride the script before them (E_{g^{-1}}), or with both open
    // the nearer one.
    let j = i;
    while (j < gs.length && !onBase(gs[j], base, size)) j++;
    const run = gs.slice(i, j),
      first = maxSize(run);
    const sub: Glyph[] = [],
      sup: Glyph[] = [];
    let up: boolean | undefined, subBase: number | undefined, supBase: number | undefined;
    for (const x of run) {
      if (x.size >= 0.9 * first || up === undefined) {
        up = x.base < base;
        if (up) supBase = x.base;
        else subBase = x.base;
      } else if (subBase !== undefined && supBase !== undefined)
        up = Math.abs(x.base - supBase) < Math.abs(x.base - subBase);
      (up ? sup : sub).push(x);
    }
    for (const [group, mark] of [
      [sub, '_'],
      [sup, '^'],
    ] as const) {
      if (!group.length) continue;
      const level = group.filter((x) => x.size >= 0.9 * first),
        lead = level.length ? level : group;
      let body = build(group, median(lead.map((x) => x.base)), maxSize(lead));
      if (mark === '^') {
        // Primes are written f', not f^{'} (a double superscript in KaTeX).
        const primes = /^'+/.exec(body)?.[0] ?? '';
        out += primes;
        body = body.slice(primes.length).trim();
      }
      if (body) out += `${mark}{${body}}`;
    }
    i = j;
  }
  return tidy(out.trim());
}
function tidy(s: string) {
  return (
    s
      // TeX builds long arrows from a bar or equals sign and an arrow.
      .replace(/MAPSTO-\\to /g, '\\longmapsto ')
      .replace(/\\Leftarrow \\Rightarrow /g, '\\Longleftrightarrow ')
      .replace(/\\leftarrow \\to /g, '\\longleftrightarrow ')
      .replace(/-\\to /g, '\\longrightarrow ')
      .replace(/=\\Rightarrow /g, '\\Longrightarrow ')
      .replace(/\\leftarrow -/g, '\\longleftarrow ')
      .replace(/\\Leftarrow =/g, '\\Longleftarrow ')
      .replace(/\.\.\./g, '\\ldots ')
      .replace(/(\\cdot ){3}/g, '\\cdots ')
      .replace(/NOT=/g, '\\neq ')
      .replace(/NOT\\in /g, '\\notin ')
      .replace(/NOT/g, '\\not ')
      .replace(/MAPSTO\\to /g, '\\mapsto ')
      .replace(/MAPSTO|SQRT/g, '')
  );
}
function texOf(gs: Glyph[]): string {
  const kept = attachAccents([...gs].sort(byX));
  if (!kept.length) return '';
  const big = maxSize(kept);
  return build(kept, median(kept.filter((g) => g.size >= 0.92 * big).map((g) => g.base)), big);
}

// ---------------------------------------------------------------------------------------------
// Fractions, roots and overlines

interface Rule {
  x0: number;
  x1: number;
  /** Middle y (down). */
  y: number;
  width: number;
}
/** Glyphs of running text (3+ text-font letters, not an operator): table cells, not a fraction. */
function wordy(gs: Glyph[]) {
  let run = '';
  for (const g of [...gs].sort(byX)) {
    if (!g.role && !g.tex && alpha(g.text)) {
      run += g.text;
      continue;
    }
    if (run.length >= 3 && !OPERATORS.has(run)) return true;
    run = '';
  }
  return run.length >= 3 && !OPERATORS.has(run);
}
/**
 * Text-font letters with no math glyph: words of a neighbouring line or an overlined word
 * ("aw" over "Eff"), not a fraction's part, whose letters TeX sets in math italic.
 */
const textLetters = (gs: Glyph[]) =>
  !gs.some((g) => g.role || g.tex) && gs.some((g) => alpha(g.text));
/** One glyph standing for a folded structure; its text is the finished LaTeX. */
function standIn(
  tex: string,
  parts: Glyph[],
  x0: number,
  x1: number,
  base: number,
  size: number,
): Glyph {
  return {
    text: tex,
    tex: true,
    role: 'mi',
    family: '',
    font: parts[0]?.font ?? '',
    size,
    base,
    x0,
    x1,
    top: Math.min(...parts.map((g) => g.top)),
    bottom: Math.max(...parts.map((g) => g.bottom)),
    boxTop: Math.min(...parts.map((g) => g.boxTop)),
    boxBottom: Math.max(...parts.map((g) => g.boxBottom)),
    pre: '',
    post: '',
    src: parts.flatMap((g) => g.src),
    folded: true,
  };
}
/**
 * The glyphs stacked right above (or below) a rule within its width: the baseline nearest the
 * rule and the scripts on it. Much larger glyphs are a neighbouring line, not the fraction.
 */
function stack(live: Glyph[], r: Rule, above: boolean, body: number): Glyph[] {
  const near = live.filter((g) => r.x0 - 0.8 <= center(g) && center(g) <= r.x1 + 0.8);
  const candidates = above
    ? near.filter((g) => g.bottom <= r.y + 0.6 && r.y - g.base < 1.6 * Math.max(g.size, body))
    : near.filter((g) => g.top >= r.y - 0.6 && g.base - r.y < 1.3 * Math.max(g.size, body));
  if (!candidates.length) return [];
  // The glyph closest to the rule sets the size and baseline of its part.
  const closest = candidates.reduce((best, g) =>
    above ? (g.base > best.base ? g : best) : g.top < best.top ? g : best,
  );
  const s = Math.max(
    ...candidates
      .filter((g) =>
        above ? g.base >= closest.base - 0.4 * g.size : g.top <= closest.top + 0.4 * g.size,
      )
      .map((g) => g.size),
  );
  const big = candidates.filter((g) => g.size >= 0.85 * s).map((g) => g.base),
    nb = above ? Math.max(...big) : Math.min(...big);
  return candidates.filter(
    (g) => g.size <= 1.15 * s && nb - 0.6 * s <= g.base && g.base <= nb + 0.45 * s,
  );
}
const extent = (gs: Glyph[]) => [
  Math.min(...gs.map((g) => g.x0)),
  Math.max(...gs.map((g) => g.x1)),
];
const isRadical = (g: Glyph) => g.tex && (g.text === 'SQRT' || g.text === '\\surd');

/** Folds fractions, square roots and overlines into stand-in glyphs, narrowest rule first. */
function fold(live: Glyph[], rules: Rule[], pageWidth: number): Glyph[] {
  if (!live.length || !rules.length) return live;
  const body = median(live.map((g) => g.size));
  const replace = (parts: Glyph[], glyph: Glyph) => {
    const gone = new Set(parts);
    return [...live.filter((g) => !gone.has(g)), glyph];
  };
  for (const r of [...rules].sort((a, b) => a.width - b.width)) {
    if (r.width > 0.6 * pageWidth) continue;
    // Square root: a radical whose top meets the rule's left end.
    const radicals = live.filter(
      (g) =>
        isRadical(g) && Math.abs(g.x1 - r.x0) < 1.5 && Math.abs(g.top - r.y) < 0.35 * g.size + 1.5,
    );
    if (radicals.length) {
      // The radicand: the baseline nearest under the rule, with its scripts (as a
      // denominator is found), not glyphs of the next line.
      const under = stack(
        live.filter((g) => !radicals.includes(g)),
        r,
        false,
        body,
      );
      if (under.length) {
        const s = maxSize(under),
          nb = median(under.filter((g) => g.size >= 0.85 * s).map((g) => g.base));
        const parts = [...under, ...radicals];
        live = replace(
          parts,
          standIn(`\\sqrt{${texOf(under)}}`, parts, radicals[0].x0, r.x1, nb, s),
        );
        continue;
      }
    }
    const numerator = stack(live, r, true, body),
      denominator = stack(live, r, false, body);
    if (numerator.length && denominator.length) {
      const [nx0, nx1] = extent(numerator),
        [dx0, dx1] = extent(denominator),
        wide = Math.max(nx1 - nx0, dx1 - dx0),
        rc = (r.x0 + r.x1) / 2,
        tolerance = Math.max(0.3 * body, 3);
      const centred =
        Math.abs((nx0 + nx1) / 2 - rc) < 0.15 * r.width + 1.5 &&
        Math.abs((dx0 + dx1) / 2 - rc) < 0.15 * r.width + 1.5;
      if (
        r.width - tolerance <= wide &&
        wide <= r.width + 1 &&
        centred &&
        !wordy(numerator) &&
        !wordy(denominator) &&
        !textLetters(numerator) &&
        !textLetters(denominator)
      ) {
        const parts = [...numerator, ...denominator],
          part = maxSize(parts);
        // Display fractions set their parts at full size, text-style ones at script size.
        const size = part >= 0.92 * body ? part : Math.min(body, part / 0.7);
        live = replace(
          parts,
          standIn(
            `\\frac{${texOf(numerator)}}{${texOf(denominator)}}`,
            parts,
            r.x0,
            r.x1,
            r.y + 0.25 * size,
            size,
          ),
        );
        continue;
      }
    }
    // Overline: math glyphs right under the rule, as wide as it.
    if (denominator.length) {
      const [dx0, dx1] = extent(denominator),
        highest = Math.min(...denominator.map((g) => g.top));
      if (
        denominator.some((g) => g.top - r.y < 0.45 * g.size + 1) &&
        denominator.some((g) => g.role) &&
        Math.abs(dx1 - dx0 - r.width) < Math.max(0.3 * body, 2.5) &&
        highest - r.y < 0.5 * body
      ) {
        const s = maxSize(denominator),
          nb = median(denominator.filter((g) => g.size >= 0.85 * s).map((g) => g.base));
        live = replace(
          denominator,
          standIn(`\\overline{${texOf(denominator)}}`, denominator, dx0, dx1, nb, s),
        );
      }
    }
  }
  return live;
}

/** Large operators whose display limits TeX sets centered above and below them. */
const LIMIT_OPERATORS =
  /^\\(sum|prod|coprod|big(oplus|otimes|odot|cup|cap|uplus|wedge|vee|sqcup))$/;
/** Integrals, whose display limits sit to the right, beside the sign. */
const INTEGRALS = /^\\(int|oint|iint)$/;
/**
 * The limit of an operator among `candidates`: the cluster of one script-size row that is
 * centred on the operator (or starts right after it, for side limits), from the row nearest
 * the operator that has one.
 */
function limitRow(candidates: Glyph[], op: Glyph, nearest: (g: Glyph) => number, side: boolean) {
  const cx = center(op),
    width = op.x1 - op.x0;
  const fits = (c: Glyph[]) => {
    const [x0, x1] = extent(c);
    return side
      ? x0 >= op.x1 - 0.3 * op.size && x0 - op.x1 < 0.6 * op.size
      : Math.abs((x0 + x1) / 2 - cx) < 0.25 * (x1 - x0 + width) + 1;
  };
  // The limit is set at script size; smaller rows are its own scripts (n^{3+2ε}), attached
  // afterwards.
  const largest = candidates.length ? maxSize(candidates) : 0;
  const left = candidates
    .filter((g) => g.size >= 0.9 * largest)
    .sort((a, b) => nearest(a) - nearest(b));
  while (left.length) {
    const first = left[0];
    const row = left.filter((g) => Math.abs(g.base - first.base) < 0.25 * first.size).sort(byX);
    // Clusters split at gaps wider than a math space.
    const clusters: Glyph[][] = [];
    for (const g of row) {
      const last = clusters.at(-1)?.at(-1);
      if (last && g.x0 - last.x1 <= 0.4 * g.size) clusters.at(-1)?.push(g);
      else clusters.push([g]);
    }
    const found = clusters.find(fits);
    if (found) return found;
    for (const g of row) left.splice(left.indexOf(g), 1);
  }
  return [];
}
/**
 * Folds the limits of large operators: script-size rows centered below and above a summation
 * (\sum_{i=1}^{n}), or beside a display integral, which sit too far from the baseline to read
 * as its scripts.
 */
function limits(live: Glyph[]): Glyph[] {
  for (const op of live.filter((g) => g.role === 'ex' && g.tex)) {
    const centered = LIMIT_OPERATORS.test(op.text),
      side = INTEGRALS.test(op.text);
    if (!centered && !side) continue;
    const others = live.filter((g) => g !== op && g.role !== 'ex' && g.size < 0.9 * op.size);
    const near = (g: Glyph) =>
      side
        ? g.x0 >= op.x1 - 0.3 * op.size && g.x0 - op.x1 < 2 * op.size
        : Math.abs(center(g) - center(op)) < 3 * op.size;
    const below = limitRow(
        others.filter(
          (g) => near(g) && g.top >= op.bottom - 0.6 * op.size && g.top <= op.bottom + op.size,
        ),
        op,
        (g) => g.top,
        side,
      ),
      above = limitRow(
        others.filter(
          (g) =>
            near(g) &&
            !below.includes(g) &&
            g.bottom <= op.top + 0.6 * op.size &&
            g.bottom >= op.top - 0.8 * op.size,
        ),
        op,
        (g) => -g.bottom,
        side,
      );
    if (!below.length && !above.length) continue;
    // A limit's own scripts (the 3+2ε̃ of n^{3+2ε̃}): smaller glyphs on its band, from its
    // left edge to just past its right one.
    const scripts = (limit: Glyph[]) => {
      if (!limit.length) return limit;
      const [x0, x1] = extent(limit),
        s = maxSize(limit),
        base = median(limit.map((g) => g.base));
      const band = others
        .filter(
          (g) =>
            !below.includes(g) &&
            !above.includes(g) &&
            g.size < 0.9 * s &&
            g.x0 >= x0 - 0.2 * s &&
            g.base - base > -0.8 * s &&
            g.base - base < 0.6 * s,
        )
        .sort(byX);
      // Left to right while each glyph follows the last within a math space.
      const extra: Glyph[] = [];
      let right = x1;
      for (const g of band) {
        if (g.x0 > right + 0.6 * s) break;
        extra.push(g);
        right = Math.max(right, g.x1);
      }
      return [...limit, ...extra];
    };
    const lower = scripts(below),
      upper = scripts(above);
    const parts = [op, ...lower, ...upper];
    let tex = op.text;
    if (lower.length) tex += `_{${texOf(lower)}}`;
    if (upper.length) tex += `^{${texOf(upper)}}`;
    const [x0, x1] = extent(parts),
      folded = standIn(tex, parts, x0, x1, op.base, op.size);
    folded.role = 'ex';
    folded.top = op.top;
    folded.bottom = op.bottom;
    const gone = new Set(parts);
    live = [...live.filter((g) => !gone.has(g)), folded];
  }
  return live;
}

// ---------------------------------------------------------------------------------------------
// Lines and math runs

/**
 * Glyphs grouped into lines: full-size glyphs set the baselines, smaller ones (scripts) join the
 * nearest line whose band and extent hold them, extension glyphs (which hang from their origin)
 * the nearest baseline below. Rows split at wide empty gaps (column gutters).
 */
function lines(live: Glyph[]): Glyph[][] {
  if (!live.length) return [];
  const body = median(live.map((g) => g.size));
  interface Row {
    y: number;
    size: number;
    gs: Glyph[];
    left: number;
    right: number;
  }
  const rows: Row[] = [];
  // Accents never start a row: TeX raises them over tall letters, up to a row's height.
  const accent = (g: Glyph) => accentOf(g) !== undefined;
  for (const g of live
    .filter((g) => g.size >= 0.85 * body && !accent(g))
    .sort((a, b) => a.base - b.base)) {
    const row = rows.find((r) => Math.abs(r.y - g.base) < 0.25 * g.size);
    if (row) row.gs.push(g);
    else rows.push({ y: g.base, size: g.size, gs: [g], left: 0, right: 0 });
  }
  for (const r of rows) {
    r.left = Math.min(...r.gs.map((g) => g.x0)) - r.size;
    r.right = Math.max(...r.gs.map((g) => g.x1)) + 1.5 * r.size;
  }
  for (const g of live.filter((g) => g.role === 'ex')) {
    // A sign at the start of a line sits left of the row's first glyph: overlap is enough.
    const target = rows
      .filter(
        (r) =>
          r.left <= g.x1 &&
          g.x0 <= r.right &&
          r.y >= g.base - 0.3 * g.size &&
          r.y <= g.base + 3 * g.size &&
          r.gs.some((x) => x.role !== 'ex'),
      )
      .sort((a, b) => a.y - b.y)[0];
    if (!target) continue;
    for (const r of rows) r.gs = r.gs.filter((x) => x !== g);
    g.base = target.y;
    g.size = target.size;
    target.gs.push(g);
  }
  const kept = rows.filter((r) => r.gs.length);
  for (const g of live) {
    if ((g.size >= 0.85 * body && !accent(g)) || g.role === 'ex') continue;
    const cx = center(g);
    let best: Row | undefined;
    for (const r of kept) {
      const d = g.base - r.y,
        [low, high] = accent(g) ? [-1.1, 0.2] : [-0.8, 0.6];
      if (!(low * r.size < d && d < high * r.size && r.left <= cx && cx <= r.right)) continue;
      if (!best || Math.abs(d) < Math.abs(g.base - best.y)) best = r;
    }
    if (best) best.gs.push(g);
    else kept.push({ y: g.base, size: g.size, gs: [g], left: g.x0, right: g.x1 });
  }
  const out: { y: number; gs: Glyph[] }[] = [];
  for (const r of kept) {
    const row = [...r.gs].sort(byX);
    let current = [row[0]],
      right = row[0].x1;
    for (const g of row.slice(1)) {
      if (g.x0 - right > 1.5 * r.size) {
        out.push({ y: r.y, gs: current });
        current = [];
      }
      current.push(g);
      right = Math.max(right, g.x1);
    }
    out.push({ y: r.y, gs: current });
  }
  return out.sort((a, b) => a.y - b.y || a.gs[0].x0 - b.gs[0].x0).map((r) => r.gs);
}
/** Footnote and affiliation markers: digits and reference symbols, commas between them. */
const marker = (t: string, first: boolean) => /^[0-9∗*†‡§¶⋆]$/u.test(t) || (!first && t === ',');
/** Drops a text-font bracket at either end of a run with no partner inside it. */
function trimBrackets(run: Glyph[]): Glyph[] {
  const unmatched = run.map(() => false),
    open: number[] = [];
  run.forEach((g, k) => {
    if (g.role || g.tex) return;
    if (g.text === '(' || g.text === '[') open.push(k);
    else if ((g.text === ')' || g.text === ']') && open.pop() === undefined) unmatched[k] = true;
  });
  for (const k of open) unmatched[k] = true;
  let lo = 0,
    hi = run.length;
  while (lo < hi && unmatched[lo]) lo++;
  while (hi > lo && unmatched[hi - 1]) hi--;
  return run.slice(lo, hi);
}
/**
 * Runs of math in a line: math-font glyphs and scripts, extended over text-font digits,
 * punctuation and operator names that sit between or next to them.
 */
function runs(line: Glyph[]): Glyph[][] {
  const n = line.length;
  if (!n || !line.some((g) => g.role)) return [];
  const body = maxSize(line);
  const math = line.map((g) => !!g.role || g.size < 0.85 * body);
  // A small raised run set tight after a word or sentence punctuation is a footnote marker
  // (Kim∗, Lee∗†, b.³), unless the word is an operator or a bracket or math follows (Aut⁰(X)).
  for (let k = 1; k < n; ) {
    const previous = line[k - 1];
    const afterText =
      !previous.role &&
      previous.size >= 0.85 * body &&
      (alpha(previous.text) || '.,;:'.includes(previous.text)) &&
      line[k].x0 - previous.x1 < 0.3 * previous.size;
    const raised = (m: number) =>
      line[m].size < 0.85 * body && line[m].base < previous.base - 0.2 * previous.size;
    if (!(afterText && raised(k) && marker(line[k].text, true))) {
      k++;
      continue;
    }
    let w = k - 1;
    while (w > 0 && !line[w - 1].role && alpha(line[w - 1].text)) w--;
    const word = line
      .slice(w, k)
      .map((g) => g.text)
      .join('');
    let j = k;
    while (j < n && raised(j) && marker(line[j].text, false)) j++;
    const tight =
      j < n &&
      line[j].x0 - line[j - 1].x1 < 0.15 * line[j].size &&
      (math[j] || line[j].text === '(');
    if (!OPERATORS.has(word) && !tight) for (let m = k; m < j; m++) math[m] = false;
    k = j;
  }
  // Grow over text-font glyphs next to math until stable: operator and function names, digits,
  // brackets and punctuation (a full stop or comma after math stays text), bold letters
  // (vectors), accents over math. Each step can bring the next within reach (2 cos 2πθ).
  const relation = /^[=<>+\-−]$/;
  for (let changed = true; changed; ) {
    changed = false;
    const join = (from: number, to: number) => {
      for (let m = from; m < to; m++)
        if (!math[m]) {
          math[m] = true;
          changed = true;
        }
    };
    // Operator and function names in a text font next to math, and a word set tight against
    // a bracket of math (ex(n, H)); a bold letter against math is a vector (\mathbf would be
    // lost, but the letter belongs to the formula).
    for (let i = 0; i < n; ) {
      if (line[i].role || line[i].tex || !alpha(line[i].text)) {
        i++;
        continue;
      }
      let j = i + 1;
      while (
        j < n &&
        !line[j].role &&
        !line[j].tex &&
        alpha(line[j].text) &&
        line[j].x0 - line[j - 1].x1 < 0.15 * line[j].size
      )
        j++;
      const word = line
        .slice(i, j)
        .map((g) => g.text)
        .join('');
      const em = line[i].size,
        near = (i > 0 && math[i - 1]) || (j < n && math[j]),
        tightRight =
          j < n && line[j].x0 - line[j - 1].x1 < 0.12 * em && (math[j] || line[j].text === '(');
      // Up to a relation's space from math (0.28 em, more before a slashed relation): n = (n_1, …).
      const boldLetter =
        j - i === 1 &&
        BOLD_FAMILY.test(line[i].family) &&
        ((i > 0 && math[i - 1] && line[i].x0 - line[i - 1].x1 < 0.5 * em) ||
          (j < n && math[j] && line[j].x0 - line[j - 1].x1 < 0.5 * em));
      // A letter or word with scripts of its own (T_p, D^b), or a name set equal to math
      // ({\rm TOL} = 10^{-6}).
      const scripted =
        j < n &&
        math[j] &&
        line[j].size < 0.85 * body &&
        line[j].x0 - line[j - 1].x1 < 0.15 * em &&
        Math.abs(line[j].base - line[j - 1].base) > 0.1 * em;
      const named =
        j - i >= 2 &&
        j - i <= 6 &&
        /^\p{Lu}/u.test(word) &&
        j + 1 < n &&
        /^[=<>]$/.test(line[j].text) &&
        line[j].x0 - line[j - 1].x1 < 0.45 * em &&
        math[j + 1] &&
        line[j + 1].x0 - line[j].x1 < 0.6 * em;
      if (
        (OPERATORS.has(word) && near) ||
        boldLetter ||
        (j - i >= 2 && tightRight && near) ||
        scripted ||
        named
      )
        join(i, named ? j + 1 : j);
      i = j;
    }
    for (let k = 0; k < n; k++)
      if (!math[k] && accentOf(line[k]) !== undefined) {
        const cx = center(line[k]);
        for (let m = Math.max(0, k - 3); m < Math.min(n, k + 4); m++)
          if (math[m] && line[m].x0 - 1 <= cx && cx <= line[m].x1 + 1) join(k, k + 1);
      }
    for (let k = 0; k < n; k++) {
      const g = line[k];
      if (math[k] || g.tex) continue;
      // A bold letter on its own (a vector) joins math up to a relation's space away.
      const vector =
        BOLD_FAMILY.test(g.family) &&
        /^[A-Za-z]$/.test(g.text) &&
        !(k > 0 && alpha(line[k - 1].text) && g.x0 - line[k - 1].x1 < 0.15 * g.size) &&
        !(k + 1 < n && alpha(line[k + 1].text) && line[k + 1].x0 - g.x1 < 0.15 * g.size);
      // So does an italic letter on its own set tight against math (newtx and mathptmx take
      // math letters from the text italic), or with math on both sides (∀ d ∈ D).
      const lone = (m: number, gap: number) =>
        !(
          m >= 0 &&
          m < n &&
          !line[m].role &&
          !math[m] &&
          alpha(line[m].text) &&
          gap < 0.15 * g.size
        );
      const letter =
        !vector &&
        ITALIC_FAMILY.test(g.family) &&
        /^[A-Za-z]$/.test(g.text) &&
        lone(k - 1, k > 0 ? g.x0 - line[k - 1].x1 : 1e9) &&
        lone(k + 1, k + 1 < n ? line[k + 1].x0 - g.x1 : 1e9);
      if (!vector && !letter && !MATH_TEXT.has(g.text)) continue;
      const gapLeft = k > 0 ? g.x0 - line[k - 1].x1 : 1e9,
        gapRight = k + 1 < n ? line[k + 1].x0 - g.x1 : 1e9,
        mathLeft = k > 0 && math[k - 1],
        mathRight = k + 1 < n && math[k + 1];
      const reach = (vector ? 0.5 : letter ? 0.2 : 0.6) * g.size;
      let left = mathLeft && gapLeft < reach,
        right = mathRight && gapRight < reach;
      // Between math on both sides, a relation or a letter may sit wider (s_{ij} \,= \,λ).
      if (!left && !right && mathLeft && mathRight && (letter || relation.test(g.text))) {
        const wide = (letter ? 0.6 : 1) * g.size;
        left = right = gapLeft < wide && gapRight < wide;
      }
      if (!left && !right) continue;
      if ('.,;:'.includes(g.text) && !right) continue;
      join(k, k + 1);
    }
  }
  const out: Glyph[][] = [];
  let current: Glyph[] = [];
  for (let k = 0; k < n; k++) {
    if (!math[k]) {
      if (current.length) out.push(current);
      current = [];
      continue;
    }
    // TeX's widest math space is about 0.3 em: a wider gap before a text-font number is a
    // table column, not math.
    const last = current.at(-1);
    if (last) {
      const gap = line[k].x0 - last.x1,
        numeral = !line[k].role && /^[0-9]+$/.test(line[k].text);
      if (gap > 1.5 * body || (numeral && gap > 0.6 * body)) {
        out.push(current);
        current = [];
      }
    }
    current.push(line[k]);
  }
  if (current.length) out.push(current);
  // Sentence punctuation before math belongs to the sentence (", $\mathcal{C}$").
  const leading = (r: Glyph[]) => {
    let k = 0;
    while (k < r.length && !r[k].role && !r[k].tex && '.,;:'.includes(r[k].text)) k++;
    return r.slice(k);
  };
  return out
    .map((r) => trimBrackets(leading(r)))
    .filter((r) => r.some((g) => g.role) || r.length > 1);
}

/** Whether a word space (0.15 em or more) precedes a run on its line. */
function spaced(line: Glyph[], run: Glyph[]) {
  const first = line.indexOf(run[0]);
  const before = line.slice(0, Math.max(0, first)).filter((g) => !run.includes(g));
  const previous = before.at(-1);
  return !!previous && run[0].x0 - previous.x1 >= 0.15 * run[0].size;
}
/**
 * Math runs of a page from its glyphs and ruling lines (PDF space), in page coordinates. Only
 * runs with structure plain text cannot show (scripts, fractions, roots, accents, alphabets)
 * are returned: a lone ± or Greek letter stays text.
 */
export function mathRuns(
  page: PageGlyphs,
  rules: PageRules['rules'],
  viewport: { width: number; transform: number[] },
): MathRun[] {
  let live = glyphs(page, viewport.transform);
  if (!live.some((g) => g.role)) return [];
  const thin: Rule[] = [];
  for (const r of rules) {
    if (r.fill || Math.abs(r.y1 - r.y2) > 0.01 || r.width > 1.2) continue;
    const box = transformBox(
      { x: Math.min(r.x1, r.x2), y: r.y1, width: Math.abs(r.x2 - r.x1), height: 0 },
      viewport.transform,
    );
    if (box.width >= 1.5)
      thin.push({ x0: box.x, x1: box.x + box.width, y: box.y, width: box.width });
  }
  live = limits(fold(live, thin, viewport.width));
  const out: MathRun[] = [];
  for (const line of lines(live))
    for (const run of runs(line)) {
      const kept = attachAccents(run);
      if (!kept.length) continue;
      const big = maxSize(kept),
        base = median(kept.filter((g) => g.size >= 0.92 * big).map((g) => g.base));
      const tex = build(kept, base, big);
      // Also runs whose plain text would be wrong: TeX's negation slash and ↦ stem have no
      // Unicode of their own (PDF.js shows "6=" for ≠).
      // Nor has the text of fonts read by code whatever PDF.js makes of them.
      const repaired = run.some(
        (g) =>
          (g.tex && (g.text === 'NOT' || g.text === 'MAPSTO')) ||
          (g.encoding !== undefined && BY_CODE.has(g.encoding)),
      );
      // And formulas of a few glyphs (x \\in X, \\tau(g\\cdot x)): one glyph alone stays text.
      const formula = kept.filter((g) => g.text.trim()).length >= 3;
      if (!tex || !(MARKS.test(tex) || repaired || formula)) continue;
      // The run's box is its line's font box, so it stays in the line during layout: script
      // or fraction ink above the line would read as a line of its own.
      const real = (g: Glyph) =>
        !g.folded && Math.abs(g.base - base) <= 0.1 * big && g.size >= 0.8 * big;
      const boxes = kept.filter(real).length ? kept.filter(real) : line.filter(real);
      out.push({
        tex,
        x0: Math.min(...run.map((g) => g.x0)),
        x1: Math.max(...run.map((g) => g.x1)),
        top: boxes.length ? Math.min(...boxes.map((g) => g.boxTop)) : base - 0.78 * big,
        bottom: boxes.length ? Math.max(...boxes.map((g) => g.boxBottom)) : base + 0.22 * big,
        size: big,
        glyphs: [...new Set(run.flatMap((g) => g.src))].sort((a, b) => a - b),
        spaceBefore: spaced(line, run),
      });
    }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Splicing math into native text

/**
 * Native spans with math runs spliced in: each run becomes a span of `$…$` LaTeX, and the text
 * spans it covers keep only the text outside it (split at glyph positions). Spans math does not
 * touch are returned unchanged. `bold` carries the weight flag over to split spans.
 */
export function spliceMath(
  native: TextSpan[],
  page: PageGlyphs,
  rules: PageRules['rules'],
  viewport: { width: number; transform: number[] },
  bold?: WeakSet<TextSpan>,
): TextSpan[] {
  const found = mathRuns(page, rules, viewport);
  if (!found.length) return native;
  const [a, , , d, e, f] = viewport.transform;
  const glyphBox = (i: number) => {
    const g = page.glyphs[i];
    return { x0: a * g.x0 + e, x1: a * g.x1 + e, base: d * g.y + f, size: g.size * Math.abs(d) };
  };
  // The native span drawing a glyph: glyph centre within its extent and baseline inside its
  // box, of the same font when one such span is (font names of text items can differ).
  const owners = new Map<number, TextSpan | undefined>();
  // Spans by the 4 pt bands of height they reach into, in drawing order: a glyph's baseline
  // band holds every span that may own it.
  const BAND = 4,
    bands = new Map<number, TextSpan[]>();
  for (const s of native) {
    if (!s.text.trim()) continue;
    const last = Math.floor((s.bbox.y + s.bbox.height + 0.5) / BAND);
    for (let k = Math.floor((s.bbox.y - 0.5) / BAND); k <= last; k++) {
      const band = bands.get(k);
      if (band) band.push(s);
      else bands.set(k, [s]);
    }
  }
  const owner = (i: number) => {
    if (owners.has(i)) return owners.get(i);
    const g = glyphBox(i),
      name = page.fonts[page.glyphs[i].font]?.name,
      cx = (g.x0 + g.x1) / 2;
    const near = (bands.get(Math.floor(g.base / BAND)) ?? []).filter(
      (s) =>
        s.bbox.x - 0.5 <= cx &&
        cx <= s.bbox.x + s.bbox.width + 0.5 &&
        s.bbox.y - 0.5 <= g.base &&
        g.base <= s.bbox.y + s.bbox.height + 0.5,
    );
    const text = page.glyphs[i].text,
      holds = (s: TextSpan) => s.text.includes(text) || s.text.includes(text.normalize('NFKC'));
    const found =
      near.find((s) => s.fontName === name && holds(s)) ??
      near.find(holds) ??
      near.find((s) => s.fontName === name) ??
      near[0];
    owners.set(i, found);
    return found;
  };
  const consumed = new Set(found.flatMap((r) => r.glyphs));
  const touched = new Map<TextSpan, number[]>();
  for (const i of consumed) {
    const span = owner(i);
    if (span) touched.set(span, []);
  }
  page.glyphs.forEach((_, i) => {
    const span = owner(i);
    if (span && touched.has(span)) touched.get(span)?.push(i);
  });
  const replacement = new Map<TextSpan, TextSpan[]>();
  for (const [span, indices] of touched) {
    indices.sort((x, y) => glyphBox(x).x0 - glyphBox(y).x0);
    replacement.set(span, remainder(span, indices, consumed, page, glyphBox, bold));
  }
  const runsAt = new Map<TextSpan, TextSpan[]>();
  const loose: TextSpan[] = [];
  for (const run of found) {
    const span: TextSpan = {
      // The space before it, when the text before ends where the run starts (its box may
      // reach into the run, which then reads as no gap).
      text: `${run.spaceBefore ? ' ' : ''}$${run.tex}$`,
      bbox: { x: run.x0, y: run.top, width: run.x1 - run.x0, height: run.bottom - run.top },
      quad: [run.x0, run.top, run.x1, run.top, run.x1, run.bottom, run.x0, run.bottom] as const,
      source: 'native',
      fontSize: run.size,
    };
    // Placed where the first span it replaces was, to keep drawing order.
    const first = run.glyphs.map(owner).find((s) => s);
    if (first) runsAt.set(first, [...(runsAt.get(first) ?? []), span]);
    else loose.push(span);
  }
  return [
    ...native.flatMap((s) => [...(runsAt.get(s) ?? []), ...(replacement.get(s) ?? [s])]),
    ...loose,
  ];
}
/**
 * The parts of a span outside math: runs of its glyphs not consumed, with the span's own text
 * for them when its characters align with the glyphs, else the glyphs' text.
 */
function remainder(
  span: TextSpan,
  indices: number[],
  consumed: Set<number>,
  page: PageGlyphs,
  glyphBox: (i: number) => { x0: number; x1: number; size: number },
  bold?: WeakSet<TextSpan>,
): TextSpan[] {
  // Character ranges of each glyph in the span text, when every glyph is found in order.
  const ranges: [number, number][] = [];
  let at = 0;
  for (const i of indices) {
    while (at < span.text.length && /\s/.test(span.text[at])) at++;
    const text = page.glyphs[i].text,
      match = [text, text.normalize('NFKC')].find((t) => span.text.startsWith(t, at));
    if (match === undefined) {
      ranges.length = 0;
      break;
    }
    ranges.push([at, at + match.length]);
    at += match.length;
  }
  const aligned = ranges.length === indices.length;
  const out: TextSpan[] = [];
  let piece: number[] = [];
  const flush = () => {
    if (!piece.length) return;
    const first = piece[0],
      last = piece[piece.length - 1],
      k0 = indices.indexOf(first),
      k1 = indices.indexOf(last);
    let text: string;
    if (aligned) {
      // Whole span when nothing before or after it was consumed.
      const start = k0 === 0 ? 0 : ranges[k0][0],
        end = k1 === indices.length - 1 ? span.text.length : ranges[k1][1];
      text = span.text.slice(start, end);
    } else
      text = piece
        .map((i, k) => {
          const gap = k ? glyphBox(i).x0 - glyphBox(piece[k - 1]).x1 : 0;
          return (gap > 0.15 * glyphBox(i).size ? ' ' : '') + page.glyphs[i].text;
        })
        .join('');
    if (text.trim()) {
      const x0 = k0 === 0 ? span.bbox.x : glyphBox(first).x0,
        x1 = k1 === indices.length - 1 ? span.bbox.x + span.bbox.width : glyphBox(last).x1,
        { y, height } = span.bbox;
      const part: TextSpan = {
        ...span,
        text,
        bbox: { x: x0, y, width: x1 - x0, height },
        quad: [x0, y, x1, y, x1, y + height, x0, y + height] as const,
      };
      out.push(part);
      if (bold?.has(span)) bold.add(part);
    }
    piece = [];
  };
  for (const i of indices) {
    if (consumed.has(i)) flush();
    else piece.push(i);
  }
  flush();
  return out;
}
