// Results of benchmark runs: where they live, how they are stored, and how two compare.
//
// A run's result (<workspace>/runs/<benchmark>/<name>/result.json) holds what produced it
// (pdfextract commit, options, pins, machine), its extraction timings and its scores, down to
// each olmOCR-bench test and each opendataloader-bench document. Committed baselines
// (benchmarks/baselines/<benchmark>.json) hold the same per engine, olmOCR-bench test outcomes
// packed into one character per test ("1" pass, "0" fail, "-" not run) in the order of the
// dataset's sorted test ids, so any run compares with them test by test.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const root = resolve(here, '..');
export const work = resolve(process.env.PDFEXTRACT_BENCH_DIR ?? join(root, '.bench'));
export const pins = Object.fromEntries(
  readFileSync(join(here, 'pins.env'), 'utf8')
    .split('\n')
    .filter((line) => /^\w+=/.test(line))
    .map((line) => line.split(/=(.*)/s).slice(0, 2)),
);
export const BENCHMARKS = {
  odl: { title: 'opendataloader-bench', data: join(work, 'opendataloader-bench') },
  olmocr: { title: 'olmOCR-bench', data: join(work, 'olmocr-bench', 'bench_data') },
};
/** Test-file names of olmOCR-bench, with the PDF folder names accepted for them. */
export const OLMOCR_ALIASES = { tables: 'table_tests' };

export const runDir = (benchmark, name) => join(work, 'runs', benchmark, name);
export const baselinePath = (benchmark) => join(here, 'baselines', `${benchmark}.json`);

/** Every olmOCR-bench test id, sorted, with its test file ("baseline" for the per-PDF tests). */
export function olmocrTests(data = BENCHMARKS.olmocr.data) {
  const tests = new Map();
  const covered = new Set();
  for (const file of readdirSync(data).filter((f) => f.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(data, file), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const test = JSON.parse(line);
      tests.set(test.id, { group: file.slice(0, -'.jsonl'.length), pdf: test.pdf });
      if (test.type === 'baseline') covered.add(test.pdf);
    }
  }
  const pdfs = readdirSync(join(data, 'pdfs'), { recursive: true }).filter((f) =>
    String(f).endsWith('.pdf'),
  );
  for (const pdf of pdfs.map(String))
    if (!covered.has(pdf)) tests.set(`${pdf}_baseline`, { group: 'baseline', pdf });
  return new Map([...tests].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
export function pack(outcomes, ids) {
  return ids.map((id) => (id in outcomes ? (outcomes[id] ? '1' : '0') : '-')).join('');
}
export function unpack(bits, ids) {
  const outcomes = {};
  ids.forEach((id, i) => {
    if (bits[i] === '1' || bits[i] === '0') outcomes[id] = bits[i] === '1';
  });
  return outcomes;
}

/**
 * A result by reference: a run name, a result.json path, or `baseline` / `baseline:<engine>`
 * (default engine pdfextract) for the committed baseline. Returns undefined when absent.
 */
export function load(benchmark, ref) {
  if (ref.startsWith('baseline')) {
    const path = baselinePath(benchmark);
    if (!existsSync(path)) return undefined;
    const engine = ref.split(':')[1] ?? 'pdfextract';
    const result = JSON.parse(readFileSync(path, 'utf8'))[engine];
    if (!result) return undefined;
    if (benchmark === 'olmocr' && typeof result.tests === 'string')
      result.tests = unpack(result.tests, [...olmocrTests().keys()]);
    return { ...result, label: `baseline:${engine}` };
  }
  const path = ref.endsWith('.json') ? resolve(ref) : join(runDir(benchmark, ref), 'result.json');
  if (!existsSync(path)) return undefined;
  return { ...JSON.parse(readFileSync(path, 'utf8')), label: ref };
}
/** A baseline file's text: one line per field, and per document for opendataloader-bench. */
export function format(baseline) {
  const field = ([key, value]) =>
    key === 'documents'
      ? `    "documents": {\n${Object.entries(value)
          .map(([id, scores]) => `      ${JSON.stringify(id)}: ${JSON.stringify(scores)}`)
          .join(',\n')}\n    }`
      : `    ${JSON.stringify(key)}: ${JSON.stringify(value)}`;
  const engines = Object.entries(baseline).map(
    ([engine, result]) =>
      `  ${JSON.stringify(engine)}: {\n${Object.entries(result).map(field).join(',\n')}\n  }`,
  );
  return `{\n${engines.join(',\n')}\n}\n`;
}
/** A result as committed in a baseline: per-test outcomes packed, no failure details. */
export function forBaseline(benchmark, result) {
  const { label: _label, details: _details, ...kept } = result;
  if (benchmark === 'olmocr') kept.tests = pack(result.tests, [...olmocrTests().keys()]);
  return kept;
}

const pct = (v) => (v === undefined ? '' : `${(100 * v).toFixed(1)}%`);
const num = (v) => (v === undefined || v === null ? '' : v.toFixed(3));
const signed = (v, scale, digits) =>
  v === undefined || Number.isNaN(v) ? '' : `${v >= 0 ? '+' : ''}${(v * scale).toFixed(digits)}`;
const mean = (values) => {
  const kept = values.filter((v) => typeof v === 'number');
  return kept.length ? kept.reduce((a, b) => a + b, 0) / kept.length : undefined;
};
function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows
    .map((r) => r.map((c, i) => (i ? String(c).padStart(widths[i]) : String(c).padEnd(widths[i]))))
    .map((r) => r.join('  ').trimEnd())
    .join('\n');
}

/** olmOCR-bench scores of a result over the given test ids: per test file and their mean. */
function olmocrScores(result, ids, groups) {
  const rows = {};
  for (const id of ids) {
    const group = groups.get(id)?.group;
    if (!group || !(id in result.tests)) continue;
    rows[group] ??= { passed: 0, total: 0 };
    rows[group].total++;
    rows[group].passed += result.tests[id] ? 1 : 0;
  }
  const rates = Object.fromEntries(Object.entries(rows).map(([g, r]) => [g, r.passed / r.total]));
  return { rates, overall: mean(Object.values(rates)), rows };
}

/**
 * The result next to references, scored over the tests (or documents) all of them have, so a
 * run of some test files compares with a full baseline on those files.
 */
export function report(benchmark, result, references = [], { flips = 0 } = {}) {
  const lines = [];
  const time = (r) =>
    r.extraction && `${(r.extraction.wallSeconds / r.extraction.documents).toFixed(3)} s/doc`;
  if (benchmark === 'olmocr') {
    const groups = olmocrTests();
    const ids = Object.keys(result.tests).filter((id) =>
      references.every((ref) => id in ref.tests),
    );
    const mine = olmocrScores(result, ids, groups);
    const theirs = references.map((ref) => olmocrScores(ref, ids, groups));
    const rows = [['', result.label, ...references.flatMap((r) => [r.label, 'Δ'])]];
    for (const group of Object.keys(mine.rates).sort())
      rows.push([
        `${group} (${mine.rows[group].total})`,
        `${pct(mine.rates[group])} ${mine.rows[group].passed}`,
        ...theirs.flatMap((t) => [
          `${pct(t.rates[group])} ${t.rows[group]?.passed ?? ''}`,
          signed(mine.rates[group] - t.rates[group], 100, 1),
        ]),
      ]);
    rows.push([
      'overall',
      pct(mine.overall),
      ...theirs.flatMap((t) => [pct(t.overall), signed(mine.overall - t.overall, 100, 1)]),
    ]);
    rows.push(['time', time(result) ?? '', ...references.flatMap((r) => [time(r) ?? '', ''])]);
    lines.push(table(rows));
    if (ids.length === groups.size && result.ci)
      lines.push(`95% CI of ${result.label}: ${pct(result.ci[0])} – ${pct(result.ci[1])}`);
    for (const ref of references.slice(0, 1)) {
      if (!flips) break;
      const gained = ids.filter((id) => result.tests[id] && !ref.tests[id]);
      const lost = ids.filter((id) => !result.tests[id] && ref.tests[id]);
      lines.push(`\nvs ${ref.label}: ${gained.length} tests now pass, ${lost.length} now fail`);
      for (const [title, list] of [
        ['now fail', lost],
        ['now pass', gained],
      ]) {
        if (!list.length) continue;
        lines.push(`  ${title}:`);
        for (const id of list.slice(0, flips))
          lines.push(
            `    ${id}${result.details?.[id] ? `  ${result.details[id].slice(0, 140)}` : ''}`,
          );
        if (list.length > flips) lines.push(`    … ${list.length - flips} more`);
      }
    }
  } else {
    const metrics = ['overall', 'nid', 'nid_s', 'teds', 'mhs'];
    const docs = Object.keys(result.documents).filter((id) =>
      references.every((ref) => id in ref.documents),
    );
    const score = (r) =>
      Object.fromEntries(metrics.map((m) => [m, mean(docs.map((id) => r.documents[id][m]))]));
    const mine = score(result),
      theirs = references.map(score);
    const rows = [['', result.label, ...references.flatMap((r) => [r.label, 'Δ'])]];
    for (const m of metrics)
      rows.push([
        m,
        num(mine[m]),
        ...theirs.flatMap((t) => [num(t[m]), signed(mine[m] - t[m], 1, 3)]),
      ]);
    rows.push(['time', time(result) ?? '', ...references.flatMap((r) => [time(r) ?? '', ''])]);
    lines.push(table(rows));
    for (const ref of references.slice(0, 1)) {
      if (!flips) break;
      const deltas = docs
        .map((id) => [id, (result.documents[id].overall ?? 0) - (ref.documents[id].overall ?? 0)])
        .filter(([, d]) => Math.abs(d) > 0.005)
        .sort((a, b) => a[1] - b[1]);
      const worse = deltas.filter(([, d]) => d < 0),
        better = deltas.filter(([, d]) => d > 0).reverse();
      lines.push(
        `\nvs ${ref.label}: ${better.length} documents better, ${worse.length} worse (overall ±0.005)`,
      );
      for (const [title, list] of [
        ['worse', worse],
        ['better', better],
      ])
        if (list.length)
          lines.push(
            `  ${title}: ${list
              .slice(0, flips)
              .map(([id, d]) => `${id} ${signed(d, 1, 3)}`)
              .join(', ')}`,
          );
    }
  }
  return lines.join('\n');
}
