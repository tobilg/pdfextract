#!/usr/bin/env bash
# Downloads the benchmark corpora and the olmOCR-bench scorer at the revisions pinned in
# pins.env, into the workspace (.bench at the repository root, or $PDFEXTRACT_BENCH_DIR).
# Safe to run again: what is already there at the pinned revision is kept.
#
# usage: benchmarks/download.sh [odl|olmocr]...   (default: both)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=pins.env
source "$here/pins.env"
work="${PDFEXTRACT_BENCH_DIR:-$(cd "$here/.." && pwd)/.bench}"
targets=("$@")
[ ${#targets[@]} -eq 0 ] && targets=(odl olmocr)

need() {
  command -v "$1" >/dev/null || {
    echo "error: $1 is required ($2)" >&2
    exit 1
  }
}
need git "https://git-scm.com"
need uv "https://docs.astral.sh/uv/getting-started/installation/"

# A shallow checkout of one commit; an existing checkout moves to it.
checkout() {
  local url=$1 commit=$2 dir=$3
  if [ -d "$dir/.git" ] && [ "$(git -C "$dir" rev-parse HEAD)" = "$commit" ]; then
    echo "  $dir at ${commit:0:7}"
    return
  fi
  mkdir -p "$dir"
  git -C "$dir" init --quiet
  git -C "$dir" remote remove origin 2>/dev/null || true
  git -C "$dir" remote add origin "$url"
  git -C "$dir" fetch --quiet --depth 1 origin "$commit"
  git -C "$dir" -c advice.detachedHead=false checkout --quiet --force FETCH_HEAD
  echo "  $dir at ${commit:0:7}"
}

count() { find "$1" -name "$2" -type f | wc -l | tr -d ' '; }

mkdir -p "$work"
echo "workspace: $work"
for target in "${targets[@]}"; do
  case $target in
  odl)
    echo "opendataloader-bench"
    checkout "$ODL_BENCH_REPO" "$ODL_BENCH_COMMIT" "$work/opendataloader-bench"
    pdfs=$(count "$work/opendataloader-bench/pdfs" '*.pdf')
    truth=$(count "$work/opendataloader-bench/ground-truth/markdown" '*.md')
    [ "$pdfs" = 200 ] && [ "$truth" -gt 0 ] || {
      echo "error: expected 200 PDFs and ground truth, found $pdfs PDFs and $truth files" >&2
      exit 1
    }
    echo "  $pdfs PDFs, $truth ground-truth files"
    ;;
  olmocr)
    echo "olmocr (scorer)"
    checkout "$OLMOCR_REPO" "$OLMOCR_COMMIT" "$work/olmocr"
    echo "olmOCR-bench (dataset, about 500 MB)"
    # hf from the pinned huggingface_hub; an interrupted download resumes.
    hub=$(grep -i '^huggingface-hub==' "$here/requirements.txt")
    uvx --quiet --python "$PYTHON_VERSION" --from "$hub" hf download "$OLMOCR_BENCH_DATASET" \
      --repo-type dataset --revision "$OLMOCR_BENCH_REVISION" \
      --local-dir "$work/olmocr-bench" >/dev/null
    data="$work/olmocr-bench/bench_data"
    pdfs=$(count "$data/pdfs" '*.pdf')
    tests=$(find "$data" -maxdepth 1 -name '*.jsonl' -type f | wc -l | tr -d ' ')
    [ "$pdfs" = 1403 ] && [ "$tests" = 7 ] || {
      echo "error: expected 1403 PDFs and 7 test files, found $pdfs and $tests" >&2
      exit 1
    }
    echo "  $data: $pdfs PDFs, $tests test files at ${OLMOCR_BENCH_REVISION:0:7}"
    ;;
  *)
    echo "error: unknown benchmark '$target' (odl or olmocr)" >&2
    exit 1
    ;;
  esac
done
echo "next: pnpm bench:setup"
