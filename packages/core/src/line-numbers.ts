import type { TextSpan } from './contracts.js';

/**
 * Line numbers printed beside running text: a manuscript's numbered lines in its margins, a
 * patent's 5, 10, 15 … in the gutter between its columns. They are no part of the text, and
 * read as text they join the lines beside them and fill the gutter that separates columns.
 *
 * A track is a vertical run of spans holding only a number, at one horizontal position, that
 * count up in one step (1, 5 or 10; numbers may be missing) at one pitch per step (a line of
 * text, within a quarter), with running text beside most of them. A column of row numbers in
 * a table has short cells beside it and stays.
 */
export function lineNumbers(spans: readonly TextSpan[]): Set<TextSpan> {
  const found = new Set<TextSpan>();
  const numbers = spans.filter((s) => value(s) !== undefined && upright(s));
  if (numbers.length < MIN_TRACK) return found;
  const words = spans.filter((s) => !numbers.includes(s) && upright(s));
  for (const track of tracks(numbers)) {
    if (track.length < MIN_TRACK) continue;
    const values = track.map((s) => value(s) as number);
    const steps: number[] = [],
      pitches: number[] = [];
    for (let k = 1; k < track.length; k++) {
      const step = values[k] - values[k - 1],
        dy = mid(track[k]) - mid(track[k - 1]);
      if (step <= 0 || dy <= 0) continue;
      steps.push(step);
      pitches.push(dy / step);
    }
    if (steps.length < (track.length - 1) * 0.8) continue;
    // Lines may be skipped (a blank line, a figure), not numbering restarted further on.
    const unit = Math.min(...steps);
    if (![1, 5, 10].includes(unit) || steps.some((s) => s % unit || s > 10 * unit)) continue;
    // One pitch per step, that of a line of text.
    const pitch = median(pitches),
      height = median(track.map((s) => s.bbox.height));
    const even = pitches.filter((p) => Math.abs(p - pitch) <= 0.25 * pitch).length;
    if (even < pitches.length * 0.8 || pitch < height * 0.8 || pitch > height * 4) continue;
    // Running text beside most of them: the text next to each, its nearest span and those
    // continuing it away from the number, is a line of four words or more and 30 characters
    // (words of letters: a table row's figures or a short cell are no running text, and the
    // prose of a column beyond the table does not count).
    const beside = track.filter((n) => {
      const line = text(n, words);
      return line.words >= 4 && line.length >= 30;
    }).length;
    if (beside < track.length * 0.6) continue;
    for (const span of track) found.add(span);
  }
  return found;
}

const MIN_TRACK = 5;
/**
 * The number a span holds alone, read as recognizers misread digits in a scan's text layer (1O
 * for 10, l5 for 15) when at least one digit is read right.
 */
function value(span: TextSpan) {
  const text = span.text.trim();
  if (!/^[\dOolI]{1,4}$/.test(text) || !/\d/.test(text)) return undefined;
  return Number(text.replace(/[Oo]/g, '0').replace(/[lI]/g, '1'));
}
const lettered = (s: TextSpan) => s.text.split(/\s+/).filter((t) => /\p{L}{2}/u.test(t)).length;
/**
 * Words and characters of the text next to a number on its line: the nearest span and those
 * following on.
 */
function text(n: TextSpan, words: readonly TextSpan[]) {
  const level = words.filter(
    (w) => Math.abs(mid(w) - mid(n)) <= 0.6 * Math.max(w.bbox.height, n.bbox.height),
  );
  const gap = (a: TextSpan, b: TextSpan) =>
    Math.max(b.bbox.x - (a.bbox.x + a.bbox.width), a.bbox.x - (b.bbox.x + b.bbox.width));
  const nearest = level.sort((a, b) => gap(n, a) - gap(n, b))[0];
  if (!nearest) return { words: 0, length: 0 };
  const right = nearest.bbox.x > n.bbox.x;
  const chain = [nearest];
  for (const w of level
    .filter((w) => (right ? w.bbox.x > nearest.bbox.x : w.bbox.x < nearest.bbox.x))
    .sort((a, b) => (right ? a.bbox.x - b.bbox.x : b.bbox.x - a.bbox.x))) {
    if (gap(chain[chain.length - 1], w) > 0.4 * w.bbox.height) break;
    chain.push(w);
  }
  return {
    words: chain.reduce((total, w) => total + lettered(w), 0),
    length: chain.reduce((total, w) => total + w.text.trim().length + 1, -1),
  };
}
const mid = (s: TextSpan) => s.bbox.y + s.bbox.height / 2;
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[sorted.length >> 1] : 0;
};
function upright(span: TextSpan) {
  const q = span.quad;
  return !q || Math.abs(q[2] - q[0]) >= Math.abs(q[3] - q[1]);
}
/**
 * Number spans grouped by horizontal position: their right edges (numbers set flush right)
 * or centres within one digit's width; each track top to bottom.
 */
function tracks(numbers: TextSpan[]): TextSpan[][] {
  const out: { right: number; center: number; spans: TextSpan[] }[] = [];
  for (const span of [...numbers].sort((a, b) => a.bbox.y - b.bbox.y)) {
    const right = span.bbox.x + span.bbox.width,
      center = span.bbox.x + span.bbox.width / 2,
      digit = span.bbox.height * 0.6;
    const track = out.find(
      (t) => Math.abs(t.right - right) <= digit || Math.abs(t.center - center) <= digit,
    );
    if (track) track.spans.push(span);
    else out.push({ right, center, spans: [span] });
  }
  return out.map((t) => t.spans);
}
