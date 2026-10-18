import { type ExtractRequest, type ExtractResponse, extract } from './extract.js';
import './style.css';

declare global {
  interface Window {
    /** The latest extraction response, for automated checks. */
    pdfextractResult?: ExtractResponse;
  }
}
const status = document.getElementById('status') as HTMLElement,
  text = document.getElementById('text') as HTMLElement,
  input = document.getElementById('pdf') as HTMLInputElement,
  mode = document.getElementById('ocr') as HTMLSelectElement,
  context = document.getElementById('context') as HTMLSelectElement,
  tables = document.getElementById('tables') as HTMLInputElement,
  composite = document.getElementById('composite') as HTMLInputElement,
  repeat = document.getElementById('repeat') as HTMLInputElement;
const worker = new Worker(new URL('./extract-worker.ts', import.meta.url), { type: 'module' });
function show(data: ExtractResponse, where: string) {
  input.disabled = false;
  window.pdfextractResult = data;
  if (!data.ok) {
    status.textContent = `Failed: ${data.error}`;
    return;
  }
  text.textContent = data.text;
  status.textContent = `Done in ${where} (DOM: ${data.dom}): ${data.images
    .map((image) => `${image.width}×${image.height} PNG ${image.bytes > 0 ? 'ok' : 'empty'}`)
    .join(', ')}`;
}
worker.onmessage = ({ data }: MessageEvent<ExtractResponse>) => show(data, 'worker');
worker.onerror = (event) => {
  input.disabled = false;
  status.textContent = `Failed: ${event.message}`;
};
input.onchange = async () => {
  const file = input.files?.[0];
  if (!file) return;
  input.disabled = true;
  text.textContent = '';
  const where = context.value === 'window' ? 'window' : 'worker';
  try {
    const request: ExtractRequest = {
      pdf: await file.arrayBuffer(),
      ocr: mode.value as ExtractRequest['ocr'],
      tables: tables.checked,
      composite: composite.checked,
      repeat: repeat.checked,
    };
    if (where === 'window') {
      status.textContent = 'Extracting in window…';
      show(await extract(request), where);
      return;
    }
    status.textContent = 'Extracting in worker…';
    // Transfer the bytes; the worker owns them from here on.
    worker.postMessage(request, [request.pdf]);
  } catch (error) {
    // Anything failing outside extract() itself must still re-enable the input.
    show({ ok: false, error: String(error) }, where);
  }
};
