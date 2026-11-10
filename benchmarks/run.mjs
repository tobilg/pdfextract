// Runs a benchmark end to end and records the result:
//   build → snapshot of the built packages → extraction (one process per job) → scoring →
//   <workspace>/runs/<benchmark>/<name>/result.json → comparison with the committed baselines.
//
// usage: node benchmarks/run.mjs <odl|olmocr> [options]   (pnpm bench <odl|olmocr> [options])
//   --name <name>         result name (default: <engine>-<commit>, "-dirty" with local changes)
//   --engine <engine>     pdfextract (default) or liteparse, the reference engine
//   --groups <a,b>        olmOCR-bench test files to run (arxiv_math, headers_footers,
//                         long_tiny_text, multi_column, old_scans, old_scans_math, table_tests
//                         or tables); default all, as the published score
//   --only <regex>        documents whose id (olmocr: <folder>/<name>.pdf) matches, for quick
//                         iterations; scores then cover those documents' tests
//   --jobs <n>            documents extracted at once, in separate processes (default 1;
//                         per-document times are only comparable between runs with equal jobs)
//   --ocr <mode>          off, auto (default) or always
//   --math <mode>         text or latex (default: latex for olmocr, text for odl)
//   --furniture <keep|omit>  running headers and footers in the Markdown (default: omit for
//                         olmocr, whose tests check they are absent; keep for odl, whose
//                         ground truth has them)
//   --format <format>     markdown (default) or text
//   --concurrency <n>     OCR workers (default: the provider's default)
//   --language-data <dir> folder of eng.traineddata.gz (default: the 4.0.0 model from
//                         @tesseract.js-data/eng)
//   --timeout <seconds>   per document (default 300)
//   --compare <refs>      comma-separated results to compare with: run names, result.json
//                         paths, baseline[:engine] (default: baseline:pdfextract,baseline:liteparse)
//   --flips <n>           list up to n tests (documents) that changed against the first
//                         reference (default 20)
//   --no-build            use the packages as built now
//   --score-only          score the outputs of an earlier run with this name again
//   --save-baseline       store this result as the committed baseline for its engine
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { resolve as absolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  BENCHMARKS,
  baselinePath,
  forBaseline,
  format,
  load,
  OLMOCR_ALIASES,
  olmocrTests,
  pins,
  report,
  root,
  runDir,
  work,
} from './lib/results.mjs';

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: 'string' },
    engine: { type: 'string', default: 'pdfextract' },
    groups: { type: 'string' },
    only: { type: 'string' },
    jobs: { type: 'string', default: '1' },
    ocr: { type: 'string', default: 'auto' },
    math: { type: 'string' },
    furniture: { type: 'string' },
    format: { type: 'string', default: 'markdown' },
    concurrency: { type: 'string' },
    'language-data': { type: 'string' },
    timeout: { type: 'string', default: '300' },
    compare: { type: 'string', default: 'baseline:pdfextract,baseline:liteparse' },
    flips: { type: 'string', default: '20' },
    'no-build': { type: 'boolean' },
    'score-only': { type: 'boolean' },
    'save-baseline': { type: 'boolean' },
  },
});
const benchmark = positionals[0];
const fail = (message) => {
  console.error(`error: ${message}`);
  process.exit(1);
};
if (!BENCHMARKS[benchmark]) fail('name a benchmark: odl or olmocr');
if (!['pdfextract', 'liteparse'].includes(args.engine)) fail('--engine is pdfextract or liteparse');
const { data, title } = BENCHMARKS[benchmark];
const python = join(work, 'venv', 'bin', 'python');
if (!existsSync(data) || !existsSync(python))
  fail(`${title} is not set up in ${work}: run pnpm bench:download && pnpm bench:setup`);

const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' }).stdout.trim();
// Local changes to the packages make a different build than the commit: their hash tells
// two dirty runs apart.
const changes = git('diff', 'HEAD', '--', 'packages');
const commit = {
  commit: git('rev-parse', '--short', 'HEAD'),
  dirty: !!changes,
  ...(changes ? { changes: createHash('sha1').update(changes).digest('hex').slice(0, 10) } : {}),
};
const name = args.name ?? `${args.engine}-${commit.commit}${commit.dirty ? '-dirty' : ''}`;
const dir = runDir(benchmark, name);
const options = {
  ocr: args.ocr,
  math: args.math ?? (benchmark === 'olmocr' ? 'latex' : 'text'),
  furniture: (args.furniture ?? (benchmark === 'olmocr' ? 'omit' : 'keep')) === 'keep',
  format: args.format,
  languages: ['eng'],
  ...(args.concurrency ? { concurrency: Number(args.concurrency) } : {}),
  ...(args['language-data'] ? { languageData: args['language-data'] } : {}),
};
const jobs = Math.max(1, Number(args.jobs) || 1);
if (args['save-baseline'] && args.groups) fail('a baseline is a full run: leave out --groups');

// The documents and where their predictions go, as each scorer expects them.
let groups;
let files;
if (benchmark === 'olmocr') {
  const tests = olmocrTests(data);
  const known = new Set([...tests.values()].map((t) => t.group));
  groups = args.groups
    ?.split(',')
    .map((g) => OLMOCR_ALIASES[g] ?? g)
    .filter(Boolean);
  for (const g of groups ?? []) if (!known.has(g)) fail(`unknown test file ${g}`);
  const pdfs = [
    ...new Set(
      [...tests.values()].filter((t) => !groups || groups.includes(t.group)).map((t) => t.pdf),
    ),
  ].sort();
  files = pdfs.map((pdf) => ({
    id: pdf,
    input: join(data, 'pdfs', pdf),
    output: join(dir, `${pdf.slice(0, -4)}_pg1_repeat1.md`),
  }));
} else {
  if (args.groups) fail('--groups applies to olmocr');
  const ids = readdirSync(join(data, 'pdfs'))
    .filter((f) => f.endsWith('.pdf'))
    .sort();
  files = ids.map((f) => ({
    id: f.slice(0, -4),
    input: join(data, 'pdfs', f),
    output: join(dir, 'markdown', `${f.slice(0, -4)}.md`),
  }));
}

/** Runs a command to completion, its output in `log` (a file in the run directory). */
function run(command, argv, { log, ...opts } = {}) {
  const fd = log ? openSync(join(dir, log), 'w') : 'ignore';
  const result = spawnSync(command, argv, { stdio: ['ignore', fd, fd], ...opts });
  if (result.status !== 0)
    fail(`${command} ${argv.join(' ')} failed${log ? `; see ${join(dir, log)}` : ''}`);
  return result;
}

/** Extracts the documents in `jobs` processes, each writing its outputs and a report. */
async function extract() {
  mkdirSync(join(dir, 'jobs'), { recursive: true });
  let build;
  if (args.engine === 'pdfextract') {
    if (!args['no-build']) {
      console.log('building @pdfextract/core and @pdfextract/ocr');
      for (const pkg of ['core', 'ocr'])
        run(process.execPath, ['scripts/build.mjs', pkg], { cwd: root, log: `build-${pkg}.log` });
    }
    build = join(dir, 'build');
    rmSync(build, { recursive: true, force: true });
    for (const pkg of ['core', 'ocr']) {
      const to = join(build, 'node_modules', '@pdfextract', pkg);
      cpSync(join(root, 'packages', pkg, 'dist'), join(to, 'dist'), { recursive: true });
      cpSync(join(root, 'packages', pkg, 'package.json'), join(to, 'package.json'));
    }
  }
  const log = openSync(join(dir, 'extract.log'), 'w');
  const shards = Array.from({ length: Math.min(jobs, files.length) }, (_, k) =>
    files.filter((_, i) => i % jobs === k),
  );
  let done = 0,
    shown = -1;
  const started = performance.now();
  // On a terminal one updating line; in a log a line per tenth.
  const tty = process.stdout.isTTY;
  const progress = () => {
    const step = Math.floor(((tty ? 100 : 10) * done) / files.length);
    if (step === shown) return;
    shown = step;
    const seconds = (performance.now() - started) / 1000;
    const line = `  ${done}/${files.length} documents, ${seconds.toFixed(0)} s`;
    process.stdout.write(tty ? `\r${line}` : `${line}\n`);
  };
  await Promise.all(
    shards.map(
      (shard, k) =>
        new Promise((resolve, reject) => {
          const spec = join(dir, 'jobs', `job-${k}.json`);
          const report = join(dir, 'jobs', `report-${k}.json`);
          writeFileSync(
            spec,
            JSON.stringify({
              build,
              languageData: absolute(
                args['language-data'] ?? join(root, 'node_modules/@tesseract.js-data/eng/4.0.0'),
              ),
              options,
              timeoutMs: Number(args.timeout) * 1000,
              files: shard,
              report,
            }),
          );
          const child =
            args.engine === 'pdfextract'
              ? spawn(process.execPath, [join(root, 'benchmarks/lib/extract.mjs'), spec], {
                  stdio: ['ignore', 'pipe', log],
                })
              : spawn(python, [join(root, 'benchmarks/python/liteparse_run.py'), spec], {
                  stdio: ['ignore', 'pipe', log],
                });
          let last = 0;
          child.stdout.setEncoding('utf8');
          child.stdout.on('data', (chunk) => {
            for (const match of chunk.matchAll(/@@ (\d+)/g)) {
              done += Number(match[1]) - last;
              last = Number(match[1]);
            }
            progress();
          });
          child.on('error', reject);
          child.on('exit', (code) =>
            code === 0
              ? resolve()
              : reject(
                  new Error(`extraction job ${k} exited with ${code}; see ${dir}/extract.log`),
                ),
          );
        }),
    ),
  );
  const wallSeconds = (performance.now() - started) / 1000;
  if (tty) process.stdout.write('\n');
  if (build) rmSync(build, { recursive: true, force: true });
  const documents = shards.flatMap((_, k) =>
    JSON.parse(readFileSync(join(dir, 'jobs', `report-${k}.json`), 'utf8')),
  );
  const ms = documents.map((d) => d.ms).sort((a, b) => a - b);
  const at = (q) => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))];
  const extraction = {
    documents: documents.length,
    failed: documents.filter((d) => d.status === 'error').length,
    partial: documents.filter((d) => d.status === 'partial').length,
    jobs,
    wallSeconds: Math.round(wallSeconds * 10) / 10,
    documentMs: {
      mean: Math.round(ms.reduce((a, b) => a + b, 0) / ms.length),
      median: at(0.5),
      p95: at(0.95),
      max: ms.at(-1),
    },
  };
  writeFileSync(join(dir, 'extraction.json'), JSON.stringify({ extraction, documents }, null, 1));
  return { extraction, documents };
}

/** Scores the predictions with the benchmark's own evaluator. */
function score(extraction) {
  if (benchmark === 'olmocr') {
    const out = join(dir, 'score.json');
    run(
      python,
      [
        join(root, 'benchmarks/python/olmocr_score.py'),
        '--data',
        data,
        '--candidate',
        dir,
        '--out',
        out,
        ...(groups ? ['--groups', groups.join(',')] : []),
        ...(args.only ? ['--pdfs', join(dir, 'documents.txt')] : []),
      ],
      { log: 'score.log' },
    );
    const scored = JSON.parse(readFileSync(out, 'utf8'));
    const tests = {},
      details = {};
    for (const [id, [passed, , , , why]] of Object.entries(scored.tests)) {
      tests[id] = passed;
      if (!passed) details[id] = why;
    }
    return {
      score: { overall: scored.overall, groups: scored.groups },
      ci: scored.ci,
      tests,
      details,
    };
  }
  // The evaluator reads the run's metadata from summary.json next to the predictions.
  writeFileSync(
    join(dir, 'summary.json'),
    JSON.stringify({
      engine_name: name,
      engine_version: `${args.engine} ${commit.commit}${commit.dirty ? ' (dirty)' : ''}`,
      processor: cpus()[0]?.model,
      document_count: files.length,
      total_elapsed: extraction?.wallSeconds,
      elapsed_per_doc: extraction && extraction.wallSeconds / extraction.documents,
      date: new Date().toISOString().slice(0, 10),
    }),
  );
  run(
    python,
    [
      'src/evaluator.py',
      '--prediction-root',
      join(work, 'runs', 'odl'),
      '--engine',
      name,
      '--log-level',
      'WARNING',
    ],
    { cwd: data, log: 'score.log' },
  );
  const evaluation = JSON.parse(readFileSync(join(dir, 'evaluation.json'), 'utf8'));
  const s = evaluation.metrics.score;
  const kept = new Set(files.map((f) => f.id));
  const documents = Object.fromEntries(
    evaluation.documents
      .filter((d) => kept.has(d.document_id))
      .map((d) => [d.document_id, d.scores]),
  );
  // With --only, the means over the documents run.
  const mean = (m) => {
    const values = Object.values(documents)
      .map((d) => d[m])
      .filter((v) => typeof v === 'number');
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined;
  };
  return {
    score: args.only
      ? Object.fromEntries(['overall', 'nid', 'nid_s', 'teds', 'mhs'].map((m) => [m, mean(m)]))
      : {
          overall: s.overall_mean,
          nid: s.nid_mean,
          nid_s: s.nid_s_mean,
          teds: s.teds_mean,
          mhs: s.mhs_mean,
        },
    documents,
  };
}

if (args.only) {
  const only = new RegExp(args.only);
  files = files.filter((f) => only.test(f.id));
  if (!files.length) fail(`no document matches ${args.only}`);
}
console.log(`${title}: ${name} (${files.length} documents)`);
let extracted;
if (args['score-only']) {
  if (!existsSync(join(dir, 'extraction.json'))) fail(`no earlier run named ${name}`);
  extracted = JSON.parse(readFileSync(join(dir, 'extraction.json'), 'utf8'));
} else {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'documents.txt'), files.map((f) => f.id).join('\n'));
  extracted = await extract();
}
console.log('scoring');
const scored = score(extracted.extraction);
const result = {
  benchmark,
  name,
  engine: args.engine,
  date: new Date().toISOString(),
  pdfextract: commit,
  options,
  ...(groups ? { groups } : {}),
  pins: Object.fromEntries(
    Object.entries(pins).filter(([k]) =>
      benchmark === 'odl' ? k.startsWith('ODL') : k.startsWith('OLMOCR'),
    ),
  ),
  machine: {
    cpu: cpus()[0]?.model,
    cores: cpus().length,
    memoryGb: Math.round(totalmem() / 2 ** 30),
    os: `${platform()} ${release()} ${arch()}`,
    node: process.version,
  },
  extraction: extracted.extraction,
  failures: extracted.documents
    .filter((d) => d.status === 'error')
    .map((d) => ({ id: d.id, error: d.error })),
  ...scored,
};
writeFileSync(join(dir, 'result.json'), JSON.stringify(result));
const references = args.compare
  .split(',')
  .filter(Boolean)
  .map((ref) => {
    const found = load(benchmark, ref);
    if (!found) console.log(`(no result ${ref} to compare with)`);
    return found;
  })
  .filter(Boolean);
console.log(
  `\n${report(benchmark, { ...result, label: name }, references, { flips: Number(args.flips) })}`,
);
if (result.failures.length)
  console.log(
    `\n${result.failures.length} documents failed: ${result.failures
      .slice(0, 5)
      .map((f) => `${f.id} (${f.error})`)
      .join(', ')}`,
  );
if (args['save-baseline']) {
  const path = baselinePath(benchmark);
  const baseline = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  baseline[args.engine] = forBaseline(benchmark, result);
  writeFileSync(path, format(baseline));
  console.log(`saved as the ${args.engine} baseline in ${path}`);
}
console.log(`\nresult: ${join(dir, 'result.json')}`);
