// Compares benchmark results: a run with others or with the committed baselines, over the
// tests (documents) they all have, and lists what changed against the first reference.
//
// usage: node benchmarks/compare.mjs <odl|olmocr> <result> [reference...] [--flips n]
//   result and references: run names (<workspace>/runs/<benchmark>/<name>), result.json paths,
//   or baseline[:engine]; references default to baseline:pdfextract and baseline:liteparse.
// With only a benchmark, lists the runs there are.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { BENCHMARKS, load, report, work } from './lib/results.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { flips: { type: 'string', default: '20' } },
});
const [benchmark, ref, ...others] = positionals;
if (!BENCHMARKS[benchmark]) {
  console.error('usage: node benchmarks/compare.mjs <odl|olmocr> <result> [reference...]');
  process.exit(1);
}
if (!ref) {
  const runs = join(work, 'runs', benchmark);
  const names = existsSync(runs)
    ? readdirSync(runs).filter((n) => existsSync(join(runs, n, 'result.json')))
    : [];
  for (const n of names.sort()) {
    const r = load(benchmark, n);
    console.log(
      `${n.padEnd(36)} ${(100 * (r.score?.overall ?? 0)).toFixed(1).padStart(5)}  ${r.date.slice(0, 16)}  ${r.pdfextract.commit}${r.pdfextract.dirty ? '+' : ''}${r.groups ? `  ${r.groups.join(',')}` : ''}`,
    );
  }
  if (!names.length) console.log(`no ${BENCHMARKS[benchmark].title} runs in ${runs}`);
  process.exit(0);
}
const result = load(benchmark, ref);
if (!result) {
  console.error(`no result ${ref}`);
  process.exit(1);
}
const references = (others.length ? others : ['baseline:pdfextract', 'baseline:liteparse'])
  .map((r) => load(benchmark, r) ?? console.error(`(no result ${r})`))
  .filter(Boolean);
console.log(report(benchmark, result, references, { flips: Number(values.flips) }));
