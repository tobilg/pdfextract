// Extracts one shard of a benchmark corpus with pdfextract. Started by run.mjs with a job file:
//   { build, languageData, options, timeoutMs, files: [{ id, input, output }], report }
// `build` holds a snapshot of the packages (node_modules/@pdfextract/{core,ocr}), so rebuilding
// the working tree during a run cannot change what the run measures. Each output is written
// as soon as its document is done; a document that fails or times out writes an empty file and
// is recorded in the report, as a missing prediction scores in the benchmark.
// Progress: one `@@ <done>` line on stdout per document.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const job = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const pkg = (name) =>
  import(pathToFileURL(join(job.build, 'node_modules/@pdfextract', name, 'dist/index-node.js')));
const { openPdf, toMarkdown } = await pkg('core');
const { createTesseractOcr } = await pkg('ocr');
const { options } = job;
const ocr =
  options.ocr === 'off'
    ? undefined
    : createTesseractOcr({
        languages: options.languages,
        ...(options.concurrency ? { concurrency: options.concurrency } : {}),
        assets: { languageDataBaseUrl: job.languageData },
      });
const documents = [];
for (const [index, file] of job.files.entries()) {
  const started = performance.now();
  const row = { id: file.id };
  let text = '';
  try {
    const pdf = await openPdf(readFileSync(file.input), {
      ocr,
      ...(options.maxOcrPixels ? { limits: { maxOcrPixels: options.maxOcrPixels } } : {}),
    });
    try {
      const result = await pdf.getStructuredText({
        ocr: options.ocr,
        math: options.math,
        errorMode: 'collect',
        signal: AbortSignal.timeout(job.timeoutMs),
      });
      text =
        options.format === 'text'
          ? result.fullText
          : toMarkdown(result, { furniture: options.furniture });
      row.status = result.status;
      const codes = [...new Set(result.warnings.map((w) => w.code))];
      if (codes.length) row.warnings = codes;
    } finally {
      await pdf.close();
    }
  } catch (error) {
    row.status = 'error';
    row.error = String(error?.code ?? error?.message ?? error);
  }
  row.ms = Math.round(performance.now() - started);
  mkdirSync(dirname(file.output), { recursive: true });
  writeFileSync(file.output, text);
  documents.push(row);
  process.stdout.write(`@@ ${index + 1}\n`);
}
await ocr?.close();
writeFileSync(job.report, JSON.stringify(documents));
