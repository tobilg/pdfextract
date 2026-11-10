import type { StructuredText, Table, TextBlock, TextPage } from './contracts.js';

/** Options for {@link toMarkdown}. */
export interface MarkdownOptions {
  /** Text placed between pages; default a thematic break (`---`) on its own paragraph. */
  pageSeparator?: string;
  /**
   * Running headers and footers ({@link TextBlock.furniture}): kept by default; false leaves
   * them out, as when the Markdown feeds a model or a search index.
   */
  furniture?: boolean;
  /**
   * Paragraph lines: `paragraph` (default) joins a paragraph's lines into one and rejoins words
   * hyphenated at a line end; `preserve` keeps the lines as laid out on the page.
   */
  lines?: 'paragraph' | 'preserve';
  /**
   * Table syntax: `auto` (default) writes a pipe table, or an HTML table where cells merge
   * (pipe tables cannot merge cells); `pipe` and `html` write every table one way.
   */
  tables?: 'auto' | 'pipe' | 'html';
}

const cell = (text: string) => text.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
/** Keeps paragraph lines from turning into headings, breaks or setext underlines by accident. */
const literal = (line: string) =>
  /^\s{0,3}(#{1,6}(\s|$)|([-*_=])\s*(\3\s*){2,}$)/.test(line) ? `\\${line.trimStart()}` : line;

/**
 * Rows of a table's header: the first row, rows its cells reach down into, rows below a header
 * cell over several (not all) columns, which name the columns it groups, and further rows while
 * the header labels fewer than half the columns (a lone label above the column names).
 */
function headerRows(table: Table) {
  const labelled = new Set<number>();
  let rows = 1;
  for (let r = 0; r < rows && rows < table.rowCount; r++) {
    for (const c of table.cells) {
      if (c.row !== r) continue;
      rows = Math.max(rows, r + c.rowSpan);
      if (c.columnSpan > 1 && c.columnSpan < table.columnCount && c.text.trim())
        rows = Math.max(rows, r + c.rowSpan + 1);
      if (c.text.trim()) for (let k = 0; k < c.columnSpan; k++) labelled.add(c.column + k);
    }
    if (r + 1 === rows && labelled.size < table.columnCount / 2) rows++;
  }
  return Math.min(rows, table.rowCount - 1) || 1;
}
const escapeHtml = (text: string) =>
  text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
/**
 * An HTML table, merged cells spanning their rows and columns; the header rows and the first
 * column (the row labels) in `th` cells.
 */
function html(table: Table): string {
  const header = headerRows(table);
  const rows = Array.from({ length: table.rowCount }, (_, r) => {
    const cells = table.cells
      .filter((c) => c.row === r)
      .sort((a, b) => a.column - b.column)
      .map((c) => {
        const tag = r < header || c.column === 0 ? 'th' : 'td';
        const span =
          (c.rowSpan > 1 ? ` rowspan="${c.rowSpan}"` : '') +
          (c.columnSpan > 1 ? ` colspan="${c.columnSpan}"` : '');
        return `<${tag}${span}>${escapeHtml(c.text)}</${tag}>`;
      });
    return `<tr>${cells.join('')}</tr>`;
  });
  return `<table>\n${rows.join('\n')}\n</table>`;
}
/** A pipe table; a merged cell's text sits in its top-left position (Markdown cannot merge). */
function pipe(table: Table): string {
  const grid = Array.from({ length: table.rowCount }, () =>
    Array<string>(table.columnCount).fill(''),
  );
  for (const c of table.cells) grid[c.row][c.column] = cell(c.text);
  const row = (cells: string[]) => `| ${cells.join(' | ')} |`;
  const [header, ...rows] = grid;
  return [row(header), row(header.map(() => '---')), ...rows.map(row)].join('\n');
}

/** A line drawn with characters: underscores, dashes, equals signs, box-drawing lines. */
const RULE = /^\s*([_\-=─━‐‑–—])\1{3,}\s*$/;
/** A list item, a numbered entry or a reference starts a line of its own. */
const ITEM = /^\s*([•▪◦‣●○■□➢►✓✔*–—-]|\(?\d{1,3}[.)]|\[\d{1,3}\]|[a-z][.)]|[ivx]{1,4}[.)])\s/i;
/** A line holding only displayed math, from `math: 'latex'`. */
const DISPLAY = /^\s*\$[^$]+\$[\s.,;]*$/;
/** LaTeX that cannot end a formula: a relation, an operator, a comma or an open bracket. */
const OPEN_END =
  /(?:[=+\-<>,([]|\\\{|\\(?:leq?|geq?|neq|in|notin|ni|subset|subseteq|supset|supseteq|to|mapsto|[Rr]ightarrow|[Ll]eftarrow|[Ll]eftrightarrow|longrightarrow|implies|iff|cdot|times|otimes|oplus|cup|cap|wedge|vee|setminus|circ|approx|sim|simeq|equiv|cong|ll|gg|mid|pm|mp|ast|coloneqq|perp|prec|succ|preceq|succeq|langle))\s*$/;
/** LaTeX that cannot start a formula: a relation, a binary operator or a closing bracket. */
const OPEN_START =
  /^\s*(?:[=+<>)\]]|\\\}|\\(?:leq?|geq?|neq|in|subset|subseteq|to|[Rr]ightarrow|implies|iff|cdot|times|otimes|oplus|cup|cap|approx|sim|equiv|rangle)(?![a-zA-Z]))/;
/**
 * An inline formula broken at a line end ($a+$ / $b=c$): the line's last formula ends open, or
 * the next line's first one starts so. The two halves are one formula.
 */
function brokenFormula(previous: string, line: string) {
  const tail = /\$([^$]+)\$$/.exec(previous)?.[1],
    head = /^\$([^$]+)\$/.exec(line)?.[1];
  return tail !== undefined && head !== undefined && (OPEN_END.test(tail) || OPEN_START.test(head));
}
/** A word broken at a line end: letters, then a hyphen (or soft hyphen). */
const BROKEN = /(\p{L}+)[-­‐]$/u;

/**
 * Words written with a hyphen somewhere in the text (well-known, TGF-beta): when one breaks at
 * a line end at its hyphen, the hyphen stays.
 */
function hyphenated(text: StructuredText) {
  const words = new Set<string>();
  for (const match of text.fullText.matchAll(/(\p{L}+)-(\p{L}+)/gu))
    words.add(`${match[1]}-${match[2]}`.toLowerCase());
  return words;
}
/**
 * A paragraph's lines as one: joined by spaces, a word hyphenated at a line end rejoined. The
 * hyphen stays where it is part of the word: after a capital (TGF-beta), before a capital, or
 * in a word written with a hyphen elsewhere. Rows of tab-separated parts, list items and
 * displayed math keep their own lines.
 */
function reflow(lines: string[], words: Set<string>): string {
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    const previous = out.at(-1);
    // A word broken at the line end continues on this line, whatever it looks like ("t. ").
    const continued =
      !!previous &&
      /[-\u00ad\u2010]$/.test(previous) &&
      BROKEN.test(previous) &&
      /^\p{Ll}/u.test(line);
    if (
      previous === undefined ||
      !line ||
      raw.includes('\t') ||
      previous.includes('\t') ||
      (ITEM.test(line) && !continued) ||
      DISPLAY.test(line) ||
      DISPLAY.test(previous)
    ) {
      out.push(raw.includes('\t') ? raw : line);
      continue;
    }
    // Only lines ending in a hyphen are tried: the pattern is costly on every line.
    const broken = /[-\u00ad\u2010]$/.test(previous) ? BROKEN.exec(previous) : null,
      next = /^\p{L}+/u.exec(line)?.[0];
    if (broken && next) {
      const head = broken[1];
      const keep =
        !previous.endsWith('­') &&
        (/\p{Lu}$/u.test(head) ||
          /^\p{Lu}/u.test(next) ||
          words.has(`${head}-${next}`.toLowerCase()));
      out[out.length - 1] = `${keep ? previous : previous.slice(0, -1)}${line}`;
      continue;
    }
    out[out.length - 1] = brokenFormula(previous, line)
      ? `${previous.slice(0, -1)} ${line.slice(1)}`
      : `${previous} ${line}`;
  }
  return out.map(literal).join('\n');
}
function block(
  block: TextBlock,
  page: TextPage,
  words: Set<string> | undefined,
  tables: MarkdownOptions['tables'],
): string {
  if (block.headingLevel)
    return `${'#'.repeat(block.headingLevel)} ${block.lines.map((l) => l.text.trim()).join(' ')}`;
  const detected = block.tableIndex !== undefined ? page.tables[block.tableIndex] : undefined;
  if (detected?.rowCount) {
    const merged = detected.cells.some((c) => c.rowSpan > 1 || c.columnSpan > 1);
    return tables === 'html' || (tables !== 'pipe' && merged) ? html(detected) : pipe(detected);
  }
  const lines = block.lines.map((l) => l.text);
  // A block of only rules typed as text (underscores, dashes) is a thematic break.
  if (lines.every((l) => RULE.test(l))) return '---';
  return words ? reflow(lines, words) : lines.map(literal).join('\n');
}

/**
 * Render structured text as Markdown: headings as `#` lines by level, detected tables as pipe
 * tables with the first row as header (as HTML tables where cells merge, which pipe tables
 * cannot show; `tables` chooses), other blocks as paragraphs on one line each (words
 * hyphenated at a line end rejoined; `lines: 'preserve'` keeps the page's lines). Running
 * headers and footers are kept unless `furniture` is false. Works on any
 * {@link StructuredText}, including one restored from JSON. Structure is inferred from the
 * layout, not read from tagged PDF.
 *
 * @example
 * ```ts
 * const markdown = toMarkdown(await pdf.getStructuredText());
 * ```
 */
export function toMarkdown(text: StructuredText, options: MarkdownOptions = {}): string {
  const furniture = options.furniture ?? true,
    words = options.lines === 'preserve' ? undefined : hyphenated(text);
  return text.pages
    .map((page) =>
      page.blocks
        .filter((b) => furniture || !b.furniture)
        .map((b) => block(b, page, words, options.tables))
        .join('\n\n'),
    )
    .join(options.pageSeparator ?? '\n\n---\n\n');
}
