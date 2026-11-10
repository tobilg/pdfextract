---
title: Text and Markdown
group: Guides
---

# Text and Markdown

{@link "@pdfextract/core".PdfDocument.getStructuredText} returns each page's text as blocks
of lines in reading order, with headings, running headers and footers and tables marked.
{@link "@pdfextract/core".toMarkdown} renders that result as Markdown. The structure is
inferred from the page's layout and type, not read from tagged PDF, and every step is
deterministic: the same document always gives the same result.

This typechecked example writes a document's Markdown for a model or a search index, with
formulas as LaTeX and running headers and footers left out, and an outline of its headings:

{@includeCode ../examples/markdown.ts}

## Reading order

Pages are read by a recursive XY-cut: the page is split at gutters, the vertical white space
between columns, and at the white space between sections, and each part is read in turn.

- Columns are read one after another. A gutter is followed through the rows it runs through,
  so columns below a title, beside a sidebar or starting at different heights are found,
  and a heading, running header or caption that spans the gutter is read in its own place
  instead of merging the columns' lines.
- Narrow gutters (down to 6 pt, as in compact journals set in small type) separate running
  text only, so a table with modest spacing still reads row by row. Newspaper columns of
  about 20 characters a line count as running text, and display lettering down a sidebar
  (type twice the text's size) is set apart from the column beside it.
- A gutter through only some rows needs running text on at least one side, or words on both
  (two panels side by side): a chart's axis labels and bar values read row by row.
- In a scan's invisible text layer, word gaps can be as wide as a gutter and line up across
  justified lines. There a narrow gutter must run through six lines to separate columns.
  A gutter that drifts on a skewed scan is followed past the drift.
- Columns that run down both sides of a figure in the middle of the page are read column by
  column; the figure's caption is read after the left column.
- Detected tables take their place as single units (see [Tables](tables.md)).

## Text of the PDF's text layer

Native text keeps the PDF's characters, with these corrections:

- Each run's box has the width PDF.js measures along its baseline, including text scaled
  horizontally or set in a Type 3 font whose matrix scales its axes differently.
- A space the text layer writes between two runs is a word break even when it is narrow, as
  in a scan's layer that fits each word to its image.
- Accents drawn as glyphs of their own join their letters: `Gr¨obner` reads `Gröbner`.
- Letter-spaced runs, which PDF.js reads with a space between every letter
  (`A R T I C L E  I N F O`), are read again from their glyph positions: `ARTICLE INFO`. Two
  single letters alone (`o f`) stay as they are.
- Line numbers printed beside the text (a manuscript's numbered lines, a patent's 5, 10, 15
  in the gutter, also as a scan's layer misreads them) are left out of it.

Recognized words from OCR keep the lines the recognizer found; see
[OCR and self-hosted assets](ocr-and-assets.md).

## Paragraphs and headings

Lines of a column form one block while they follow each other at about line spacing and
overlap horizontally. A paragraph cut by the edge of a reading-order region continues in the
next block when its sentence goes on there.

Blocks set in larger type than the page's body text (or bold where the body is not), short
and not ending in a sentence, are headings: `TextBlock.headingLevel` is 1 for the largest
type on the page, 2 for the next, and so on. A line that only names a conventional section
("Contents", "References", "Appendix A") and opens its block is one too. Running headers and
footers, leaders, numbered captions ("Table 2:"), dates, links, numbers, contents entries,
lines within a sentence and more than three lines in a row of large type (a passage, not a
heading) are not.

## Running headers and footers

`TextBlock.furniture` marks page furniture:

| Value | Marked blocks |
| --- | --- |
| `'header'`, `'footer'` | Short blocks in the top or bottom 15% of a page, set apart from the text: journal lines, running titles, page numbers, copyright, download and citation notices; and text repeated at the same height across the extracted pages |
| `'margin'` | Text set at a quarter turn in the outer tenth of the page width (a preprint identifier, a download stamp) |

Prose, sentences at the body size, paragraphs continued from the previous page, captions,
equation numbers, footnotes and headings near an edge are not marked. The blocks stay in
`blocks` and `fullText`; leave them out where they would repeat on every page.

## Markdown

`toMarkdown(result, options)` works on any structured result, including one restored from
JSON:

| Block | Markdown |
| --- | --- |
| Heading | A `#` line by level |
| Paragraph | One line: its lines joined, words hyphenated at a line end rejoined (the hyphen stays in words the document writes with one), an inline formula broken at a line end joined |
| Table | A pipe table, or an HTML table where cells merge (`rowspan`, `colspan`) |
| Rows of tab-separated parts, list items, displayed math | Their own lines |
| A line of underscores or dashes | A thematic break |
| Page boundary | A thematic break (`---`) |

{@link "@pdfextract/core".MarkdownOptions} change the defaults:

| Option | Default | Effect |
| --- | --- | --- |
| `furniture` | `true` | `false` leaves running headers and footers out |
| `lines` | `'paragraph'` | `'preserve'` keeps each paragraph's lines as on the page |
| `tables` | `'auto'` | `'pipe'` or `'html'` writes every table one way |
| `pageSeparator` | `'\n\n---\n\n'` | Text placed between pages |

## Math as LaTeX

On pages typeset with TeX (papers from LaTeX, arXiv preprints), `math: 'latex'` rebuilds
formulas from their glyphs and puts them into the text as `$…$` LaTeX:

```ts
const markdown = toMarkdown(await pdf.getStructuredText({ math: 'latex' }));
// … where $x_{i}\in \mathbb{R}^{n}$ and $\sum_{i=1}^{n}x_{i}=1$ …
```

Math fonts (Computer Modern, AMS, Latin Modern, tx/px and newtx, mathabx, Euler, rsfs,
OpenType math fonts such as STIX Two Math), TeX's font encodings and Unicode math letters
give the symbols; glyph size and baseline give sub- and superscripts; the thin rules TeX
draws give fractions, roots and overlines; centred script rows give the limits of sums and
integrals. Operator names and upright words in formulas become `\operatorname` or their
command (`\cos`). Formulas with structure plain text cannot show, or of three glyphs or
more, become LaTeX; a lone `±` or Greek letter stays text. Text around a formula keeps its
own spans.

Pages without TeX math fonts are unaffected, and pages with them cost one more glyph scan.
No model is involved: math drawn as images or vector outlines, or set in text fonts only,
is not read, and an accent from a text font over a formula letter may stay apart from it.
The default `math: 'text'` keeps the glyphs' Unicode text.

## Limits

Reading order and structure are heuristics. Overlapping layouts, magazine spreads with
text flowing around several images, bidirectional or vertical scripts, rotated
multi-column content and charts can need review in the application. The repository's
[benchmarks](https://github.com/tobilg/pdfextract/tree/main/benchmarks) measure the text,
reading order, tables, headings and math on two public corpora.
