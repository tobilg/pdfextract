#!/usr/bin/env bash
# Prepares everything the benchmarks run with, after download.sh: a Python environment with
# the pinned scorer packages (requirements.txt), olmocr from its pinned clone, Chromium for
# olmOCR-bench's math rendering tests, and a build of pdfextract.
# Safe to run again.
#
# usage: benchmarks/setup.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
# shellcheck source=pins.env
source "$here/pins.env"
work="${PDFEXTRACT_BENCH_DIR:-$root/.bench}"
venv="$work/venv"
python="$venv/bin/python"

need() {
  command -v "$1" >/dev/null || {
    echo "error: $1 is required ($2)" >&2
    exit 1
  }
}
need uv "https://docs.astral.sh/uv/getting-started/installation/"
need node "Node.js 22.12 or later"
need pnpm "https://pnpm.io/installation"
[ -d "$work/olmocr/.git" ] || {
  echo "error: $work/olmocr is missing; run benchmarks/download.sh first" >&2
  exit 1
}

echo "Python $PYTHON_VERSION environment: $venv"
version() { "$python" -c 'import sys; print("%d.%d" % sys.version_info[:2])'; }
if [ -x "$python" ] && [ "$(version)" != "$PYTHON_VERSION" ]; then rm -rf "$venv"; fi
[ -x "$python" ] || uv venv --quiet --python "$PYTHON_VERSION" "$venv"
# Exactly the pinned set: packages not in requirements.txt are removed.
uv pip sync --quiet --python "$python" "$here/requirements.txt"
uv pip install --quiet --python "$python" --no-deps -e "$work/olmocr"
"$python" -c "import apted, liteparse, olmocr.bench.tests, olmocr.bench.utils" || {
  echo "error: the scorer packages do not import" >&2
  exit 1
}

echo "Chromium for olmOCR-bench math rendering"
"$python" -m playwright install chromium >/dev/null

echo "pdfextract build"
cd "$root"
log="$work/setup-build.log"
{ pnpm install --frozen-lockfile && pnpm build; } >"$log" 2>&1 || {
  tail -20 "$log" >&2
  echo "error: pdfextract did not build; see $log" >&2
  exit 1
}
echo "ready: pnpm bench odl | pnpm bench olmocr   (see benchmarks/README.md)"
