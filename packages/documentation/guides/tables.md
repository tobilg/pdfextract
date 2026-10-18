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
  two rows and two columns. Stroked lines and thin filled rectangles (up to 4 pt) count
  as rules; white and clipped-away lines do not. An interior edge without a rule merges
  the neighbouring grid cells, so `rowSpan`/`columnSpan` describe merged cells. A table
  edge may be implied by where the rules in the other direction end. At least half of
  the cells must contain text, in at least two rows and two columns, so sparse grids
  (charts, forms) are not tables. A grid whose horizontal lines mostly carry a short label
  (up to 8 characters) just outside it, like a chart's axis, is rejected too; text inside
  another grid, such as a table next to it, does not count as a label.
- **aligned**: consecutive text rows that split into segments at gaps wider than half a
  line height, with the segments lining up into columns. This needs at least three
  columns and three rows, or two of each when horizontal rules sit just above the first
  row and just below the last (booktabs style). At least half of the cells must contain
  text. A single-segment row that stays within one column continues the cell above it
  (a wrapped line); anything else ends the table. Columns that read as prose (more than
  six words per cell on average, or lines that mostly fill the column width) reject the
  candidate, so multi-column articles are not reported as tables. A first column of
  bullets or dashes in at least 80% of rows makes the candidate a list, not a table. Item
  numbers and letters (`1.`, `a)`) do not, since they also label table rows.

Distances such as how close two lines must be to count as one grid line are tuned for
10 pt text and scale with the text they measure (heights between 4 and 40 pt count): a
ruled grid is measured by the text inside it, an aligned table by its rows, so a fine-print
table on a page of body text is measured like any other.

Ruled detection runs first; aligned detection only considers the remaining text.

## Results

`Table.cells` lists every grid position in row-major order, empty cells included, except
positions covered by a merged cell. Cell `bbox` is the cell's grid area, not only its text;
cell `text` joins the cell's lines with newlines.

In the text layout, each table becomes one block with `tableIndex` set to its index in
`tables`. The block has one line per non-empty row, and each line has one field per
grid column separated by tab characters, so `fullText` keeps tables readable row by row.
Line spans keep their native/OCR provenance. OCR words take part in detection like
native text.

Outside detected tables, text fragments on one row that are too far apart to join
directly are still kept on one line, separated by a tab.

## Limits and cost

Two-column tables without rules, tables whose cells hold full sentences, header cells
centered across several unruled columns, and tables with only vertical rules are read as
ordinary text. Rotated or skewed tables are not detected. Charts whose grid cells mostly
hold labels can still be reported as ruled tables.

Ruling lines come from a pass over the page's vector graphics in the engine worker. It
only runs on pages whose text could form a table: a row of three or more separated
segments, or two split rows whose second segments line up. A page whose only split row is
a header with a page number is not scanned. The ruling lines of scanned pages are cached
compactly for the document's lifetime, within `limits.maxCachedRuleLines` (default 200,000
lines, about 8 MB). A page draws at most 5,000 lines, so the default holds at least 40 pages;
when it is full, the pages cached first are dropped and scanned again if needed. Pass
`tables: false` to skip detection entirely.

If ruling lines are unavailable, tables are detected from text alignment alone and the
page gets a `TABLE_DETECTION_DEGRADED` warning. The same warning reports pages that draw
more than 5,000 lines; only the first 5,000 are used.
