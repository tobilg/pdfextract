---
title: Tables
group: Guides
---

# Tables

`getStructuredText` detects tables by default and returns them in each page's `tables`,
in reading order. Detection is heuristic and geometric: it does not use tagged-PDF
structure and does not interpret what a table means.

```ts
const text = await pdf.getStructuredText();
for (const table of text.pages[0].tables) {
  const grid = Array.from({ length: table.rowCount }, () =>
    Array<string>(table.columnCount).fill(''),
  );
  for (const cell of table.cells) grid[cell.row][cell.column] = cell.text;
  console.table(grid);
}
```

## Detection

- **ruled**: drawn horizontal and vertical lines that cross form a grid of at least
  two rows and two columns. Stroked lines and thin filled bars (up to 4 pt, also with
  mitred ends) count as rules, as do the edges of a filled ring with only horizontal and
  vertical sides (an outer border drawn as one frame shape); white and clipped-away lines do
  not. Shaded cells, striped rows and colored headers outline tables too: a second pass adds
  the edges of filled areas, and its table replaces the first pass's only when it holds more
  text, or the same text in more cells. An interior edge without a rule merges
  the neighbouring grid cells, so `rowSpan`/`columnSpan` describe merged cells. A table
  edge may be implied by where the rules in the other direction end. At least half of
  the cells must contain text, in at least two rows and two columns, so sparse grids
  (charts, forms) are not tables, unless the header row names columns and the first column
  labels the rows (a fill-in worksheet). A one-column grid of at least four boxes, each a
  short entry, is a table (a list drawn as boxes). A grid whose horizontal lines mostly carry a short label
  (up to 8 characters) just outside it, like a chart's axis, is rejected too; text inside
  another grid, such as a table next to it, does not count as a label. When the text inside
  a ruled table aligns into more columns than its rules draw (rules around groups of cells,
  booktabs-style tables with few lines), and that grid holds at least 80% of the table's
  text, the finer grid is the table (reported as aligned). So is a grid with as many columns
  and more rows when its cells are short (figures, labels) and every filled cell of a ruled
  row holds about as many lines (rules drawn around columns, each holding a column of
  figures); a header wrapped over two lines beside one-line cells stays one row. A cell over several rows whose
  lines each sit level with text of their own row, in three or more rows, is split into one
  cell per row (a label column drawn without row rules beside ruled values); a cell over
  several columns whose separate pieces of text each lie within one of them is split into
  one cell per column (a spreadsheet's gridlines drawn only in its header). Rows and columns
  in which no cell of their own holds text (grid lines added by shading set inside a cell's
  border, spacer rows) are removed. A native text run written across a drawn column rule
  (a row number and its label in one run) is split at the space nearest the rule first.
- **aligned**: consecutive text rows that split into segments at gaps wider than half a
  line height, with the segments lining up into columns. A stored text layer set a word per
  span with wide word gaps (the invisible text of a scan) splits only at gaps over 1.5 times
  its median word gap (at most 1.2 line heights). A row starting with a caption
  (`Table 3`, `TABLE II`) ends the table above it and starts the next. This needs at least three
  columns and three rows, or two of each when horizontal rules sit just above the first
  row and just below the last (booktabs style). Smaller grids count in two shapes: two rows
  of figures across four or more columns, and two columns of four or more short entries
  (names and affiliations) that are not running text. Headers over several columns would
  merge those columns; an accepted table takes its columns from the rows with the most
  common number of segments (the data rows) instead, the wider cells spanning them, when
  every such column holds text in at least half the rows. At least half of the cells must contain
  text. A single-segment row that stays within one column continues the cell above it
  (a wrapped line). A few words starting the first column, set apart by space or ending in a
  colon, between rows alike (as many segments, most starting or ending at the same places)
  label the rows below (`Teachers by degree:`): a row of their own, so the table goes on.
  Anything else ends the table. Columns that read as prose (more than
  six words per cell on average, or lines that mostly fill the column width) reject the
  candidate, so multi-column articles are not reported as tables. A first column of
  bullets or dashes in at least 80% of rows makes the candidate a list, not a table. Item
  numbers and letters (`1.`, `a)`) do not, since they also label table rows. A last column
  of ascending page numbers (Roman front matter included) makes the candidate a table of
  contents, not a table. A candidate that fails because lines of running text joined it
  (a two-column page below a table) is cut at those lines (a part of six words and 35
  characters, or below the first row a row of a dozen words); a piece is kept only if it holds
  figures: four or more rows, cells past the first column mostly digits. Text set at a
  quarter turn (margin stamps) takes no part, unless most of the page's text is turned.
- **aligned, between rules**: horizontal rules of one width without vertical ones also
  bound tables whose rows are too sparse for alignment, such as a column left empty below
  its header. Three or more rules bound one row each; with two (booktabs), the lines between
  them are the rows. Below a header row, lines that each hold several short cells are rows
  of their own (a booktabs body between a mid and a bottom rule), not one row's wrapped
  lines. The header row's text segments, at least two of them naming columns
  (not numbers, as chart values between gridlines are), define the columns.

Distances such as how close two lines must be to count as one grid line are tuned for
10 pt text and scale with the text they measure (heights between 4 and 40 pt count): a
ruled grid is measured by the text inside it, an aligned table by its rows, so a fine-print
table on a page of body text is measured like any other.

Ruled detection runs first; aligned detection only considers the remaining text, and
detection between rules the text left after that.

## Results

`Table.cells` lists every grid position in row-major order, empty cells included, except
positions covered by a merged cell. Cell `bbox` is the cell's grid area, not only its text;
cell `text` joins the cell's lines with newlines.

In the text layout, each table becomes one block with `tableIndex` set to its index in
`tables`. The block has one line per non-empty row, and each line has one field per
grid column separated by tab characters, so `fullText` keeps tables readable row by row.
Line spans keep their native/OCR provenance. OCR words take part in detection like
native text; each takes its recognized line's top and bottom, so short words stay in their
row. `toMarkdown` renders each table as a pipe table whose first row is the header. A table
with merged cells, which pipe tables cannot show, becomes an HTML table instead: merged cells
span their rows and columns (`rowspan`, `colspan`), and the header rows and the first column
are `th` cells. The header is the first row, the rows its cells reach into, the row below a
header cell over several columns (which names the columns it groups), and further rows while
the header labels fewer than half the columns. `tables: 'pipe'` or `'html'` writes every
table one way (`'pipe'` keeps a merged cell's text in its top-left position).

Outside detected tables, text fragments on one row that are too far apart to join
directly are still kept on one line, separated by a tab.

## Limits and cost

Two-column tables without rules, tables whose cells hold full sentences, header cells
centered across several unruled columns, and tables with only vertical rules are read as
ordinary text. Rotated or skewed tables are not detected. Charts whose grid cells mostly
hold labels can still be reported as ruled tables.

Ruling lines come from the pass over the page's vector graphics in the engine worker that
also reads its font names and filled shapes for text extraction, so they cost no separate
scan. Detection runs on pages whose text could form a table (a row of three or more
separated segments, or two split rows whose second segments line up) and on pages that draw
at least four lines. The ruling lines of scanned pages are cached
compactly for the document's lifetime, within `limits.maxCachedRuleLines` (default 200,000
lines, about 8 MB). A page draws at most 5,000 lines, so the default holds at least 40 pages;
when it is full, the pages cached first are dropped and scanned again if needed. Pass
`tables: false` to skip detection entirely.

If ruling lines are unavailable, tables are detected from text alignment alone and the
page gets a `TABLE_DETECTION_DEGRADED` warning. The same warning reports pages that draw
more than 5,000 lines; only the first 5,000 are used.
