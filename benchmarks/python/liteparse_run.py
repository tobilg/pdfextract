"""Extracts one shard of a benchmark corpus with liteparse, the reference engine.

Started by run.mjs with the same job file as lib/extract.mjs:
  { options, files: [{ id, input, output }], report }
Markdown output with OCR on (liteparse's default Tesseract engine), or plain text with
`options.format == "text"`. A document that fails writes an empty file and is recorded.
Progress: one `@@ <done>` line on stdout per document.
"""

import json
import os
import sys
import time

from liteparse import LiteParse

job = json.load(open(sys.argv[1], encoding="utf-8"))
options = job["options"]
markdown = options.get("format") != "text"
parser = LiteParse(
    ocr_enabled=options.get("ocr") != "off",
    quiet=True,
    **({"output_format": "markdown"} if markdown else {}),
)
documents = []
for index, file in enumerate(job["files"], 1):
    started = time.perf_counter()
    row = {"id": file["id"], "status": "complete"}
    text = ""
    try:
        result = parser.parse(file["input"])
        if markdown:
            text = "\n\n".join(p.markdown for p in result.pages if p.markdown) or result.text
        else:
            text = result.text
    except Exception as error:  # a missing document scores as empty
        row["status"] = "error"
        row["error"] = str(error)[:200]
    row["ms"] = round((time.perf_counter() - started) * 1000)
    os.makedirs(os.path.dirname(file["output"]), exist_ok=True)
    with open(file["output"], "w", encoding="utf-8") as f:
        f.write(text)
    documents.append(row)
    print(f"@@ {index}", flush=True)
with open(job["report"], "w", encoding="utf-8") as f:
    json.dump(documents, f)
