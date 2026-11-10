"""Scores a candidate's olmOCR-bench outputs with olmocr's own test classes.

The score is computed as olmocr.bench.benchmark computes it for one repeat per PDF: every
test passes or fails on the candidate's `<pdf>_pg<page>_repeat1.md`, each test file (and the
per-PDF baseline tests, as their own group) gets its pass rate, and the overall score is the
mean of those rates, with a bootstrap confidence interval resampled within each group. Unlike
benchmark.py it can score a subset of the test files, takes the candidate folder from
anywhere, seeds the bootstrap (so the interval repeats), and writes every test's outcome.

usage: python olmocr_score.py --data <bench_data> --candidate <dir> --out <score.json>
                              [--groups arxiv_math,table_tests,...] [--pdfs <list file>]
"""

import argparse
import glob
import json
import os
import random
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from olmocr.bench.tests import BaselineTest, load_tests
from olmocr.bench.utils import calculate_bootstrap_ci

parser = argparse.ArgumentParser()
parser.add_argument("--data", required=True)
parser.add_argument("--candidate", required=True)
parser.add_argument("--out", required=True)
parser.add_argument("--groups", default="")
parser.add_argument("--pdfs", help="file listing the PDFs (one per line) whose tests to run")
args = parser.parse_args()

wanted = {g for g in args.groups.split(",") if g}
files = sorted(glob.glob(os.path.join(args.data, "*.jsonl")))
names = [os.path.basename(f)[: -len(".jsonl")] for f in files]
unknown = wanted - set(names) - {"baseline"}
if unknown:
    raise SystemExit(f"unknown test files {sorted(unknown)}; known: {', '.join(names)}")
tests, group = [], {}
for path, name in zip(files, names):
    if wanted and name not in wanted:
        continue
    for test in load_tests(path):
        tests.append(test)
        group[test.id] = name
if args.pdfs:
    with open(args.pdfs, encoding="utf-8") as f:
        only = {line.strip() for line in f if line.strip()}
    tests = [t for t in tests if t.pdf in only]
# As benchmark.py: every PDF gets a baseline test (readable text, no garbage) in its own
# group. A subset run checks the PDFs its test files cover.
if wanted or args.pdfs:
    pdfs = sorted({t.pdf for t in tests} | (only if args.pdfs else set()))
else:
    root = os.path.join(args.data, "pdfs")
    pdfs = sorted(os.path.relpath(p, root) for p in glob.glob(os.path.join(root, "**/*.pdf"), recursive=True))
for pdf in pdfs:
    if not any(t.type == "baseline" and t.pdf == pdf for t in tests):
        test = BaselineTest(id=f"{pdf}_baseline", pdf=pdf, page=1, type="baseline")
        tests.append(test)
        group[test.id] = "baseline"


def run(test):
    path = os.path.join(args.candidate, f"{os.path.splitext(test.pdf)[0]}_pg{test.page}_repeat1.md")
    try:
        with open(path, encoding="utf-8") as f:
            content = f.read()
    except OSError:
        return False, "missing output"
    try:
        return test.run(content)
    except Exception as error:  # as benchmark.py: a test that raises fails
        return False, f"error: {error}"


with ThreadPoolExecutor(max_workers=min(os.cpu_count() or 1, 64)) as pool:
    outcomes = list(pool.map(run, tests))

groups, types = {}, {}
for test, (passed, _) in zip(tests, outcomes):
    for table, key in ((groups, group[test.id]), (types, test.type)):
        row = table.setdefault(key, {"passed": 0, "total": 0})
        row["passed"] += bool(passed)
        row["total"] += 1
rates = [g["passed"] / g["total"] for g in groups.values()]
order = sorted(groups)
scores = [float(bool(p)) for name in order for t, (p, _) in zip(tests, outcomes) if group[t.id] == name]
random.seed(0)
np.random.seed(0)
ci = calculate_bootstrap_ci(scores, n_bootstrap=1000, ci_level=0.95, splits=[groups[n]["total"] for n in order])
result = {
    "overall": sum(rates) / len(rates),
    "ci": [float(ci[0]), float(ci[1])],
    "groups": {n: groups[n] for n in order},
    "types": {n: types[n] for n in sorted(types)},
    "tests": {
        t.id: [bool(p), group[t.id], t.type, t.pdf] + ([] if p else [str(why)[:300]])
        for t, (p, why) in zip(tests, outcomes)
    },
}
with open(args.out, "w", encoding="utf-8") as f:
    json.dump(result, f)
print(f"olmOCR-bench: {100 * result['overall']:.1f}% over {len(tests)} tests")
