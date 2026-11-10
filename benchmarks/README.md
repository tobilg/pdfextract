# Benchmarks

Two public benchmarks measure extraction quality, with liteparse as the reference engine:

- **opendataloader-bench**: 200 PDFs (papers, reports, forms, scans) with Markdown ground
  truth. Its evaluator scores reading order (NID, NID-S), tables (TEDS) and heading structure
  (MHS); `overall` is their mean.
- **olmOCR-bench**: 1,403 single-page PDFs with 7,010 unit tests in seven test files: TeX math
  (`arxiv_math`, `old_scans_math`), `headers_footers` (running headers and footers must be
  absent), `long_tiny_text`, `multi_column` (reading order), `old_scans` and `table_tests`, plus
  a baseline test per PDF (readable text). The score is the mean of the test files' pass rates,
  as olmocr's `benchmark.py` computes it.

Everything a score depends on is pinned: the corpora and the scorer by commit
([`pins.env`](pins.env)), the Python packages by exact version
([`requirements.txt`](requirements.txt)), pdfextract by the commit (and a hash of local
changes) recorded with each result. Extraction runs on a snapshot of the built packages, so
rebuilding the working tree mid-run changes nothing, and documents run in a fixed order with
fixed options. The same commit gives the same predictions and scores; only timings depend on
the machine and its load.

## Setup

Needs Node.js 22.12+, pnpm, git and [uv](https://docs.astral.sh/uv/) (which provides Python).

```sh
pnpm bench:download   # corpora and scorer at the pinned revisions (about 750 MB)
pnpm bench:setup      # Python environment, Chromium for math tests, pdfextract build
```

Both go to `.bench/` at the repository root (ignored by git); set `PDFEXTRACT_BENCH_DIR` to
put them elsewhere. Both can run again: they keep what is already at the pinned revision.
`pnpm bench:download odl` (or `olmocr`) fetches one benchmark.

## Running

```sh
pnpm bench odl                            # about 1 minute
pnpm bench olmocr                         # about 25 minutes
pnpm bench olmocr --groups tables         # some test files only
pnpm bench olmocr --jobs 4                # four documents at once
pnpm bench odl --engine liteparse         # the reference engine
pnpm bench olmocr --only '^old_scans/1\d\.pdf$' --jobs 4   # some documents, for quick iterations
```

A run builds `@pdfextract/core` and `@pdfextract/ocr` (`--no-build` uses the current build),
extracts every document, scores the predictions with the benchmark's own evaluator, and prints
the scores next to the committed baselines, with the tests (or documents) that changed:

```text
                      pdfextract-c321b06  baseline:pdfextract     Δ  baseline:liteparse      Δ
arxiv_math (2927)             77.5% 2267          77.5% 2267  +0.0          52.3% 1530  +25.2
...
table_tests (1022)             64.7% 661           64.7% 661  +0.0           53.5% 547  +11.2
overall                            61.8%               61.8%  +0.0               45.3%  +16.5
time                         0.204 s/doc         0.204 s/doc               1.276 s/doc
```

Runs with `--groups` compare on the same tests only, so a run of `table_tests` compares with
the table tests of a full baseline. The result lands in
`.bench/runs/<benchmark>/<name>/result.json` (default name `<engine>-<commit>`, with `-dirty`
for local changes; `--name` sets it), next to the predictions, the extraction log and per
document timings. Per-document timeouts (`--timeout`, default 300 s) and failures are recorded;
a failed document scores as an empty prediction.

Defaults follow what each benchmark measures: OCR `auto`, Markdown output; for olmOCR-bench
`math: 'latex'` (its math tests read LaTeX) and running headers and footers left out (its tests
require them absent); for opendataloader-bench `math: 'text'` and headers and footers kept (its
ground truth has them). `--ocr`, `--math`, `--furniture`, `--format`, `--concurrency` and
`--language-data` (another Tesseract model folder) override them. `--only <regex>` runs the
documents whose id matches and scores their tests only.

## Comparing

```sh
pnpm bench:compare olmocr                           # list the runs
pnpm bench:compare olmocr my-change                 # against the baselines
pnpm bench:compare olmocr my-change before-change   # against another run
pnpm bench:compare odl my-change baseline --flips 40
```

`--score-only` scores an earlier run's predictions again (after changing nothing but the
scorer). The official olmOCR-bench scorer reads candidates from the dataset folder; to use it,
link a run there:

```sh
ln -s "$PWD/.bench/runs/olmocr/<name>" .bench/olmocr-bench/bench_data/<name>
.bench/venv/bin/python -m olmocr.bench.benchmark --dir .bench/olmocr-bench/bench_data --candidate <name>
```

## Baselines

[`baselines/`](baselines) holds the full-run results of pdfextract and liteparse that runs
compare with: scores, options, pins, machine and timings, and every olmOCR-bench test's outcome
(one character per test, in the order of the sorted test ids) and every opendataloader-bench
document's scores. After a change that moves the scores, record the new pdfextract baseline
with a full run:

```sh
pnpm bench olmocr --save-baseline
pnpm bench odl --save-baseline
```

The liteparse baselines were recorded with `--engine liteparse --save-baseline` and change only
with the pinned liteparse version.
