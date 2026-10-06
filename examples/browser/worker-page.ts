import type { ExtractRequest, ExtractResponse } from './extract-worker.js';
import './style.css';

const status = document.getElementById('status') as HTMLElement,
  text = document.getElementById('text') as HTMLElement,
  input = document.getElementById('pdf') as HTMLInputElement,
  mode = document.getElementById('ocr') as HTMLSelectElement;
const worker = new Worker(new URL('./extract-worker.ts', import.meta.url), { type: 'module' });
worker.onmessage = ({ data }: MessageEvent<ExtractResponse>) => {
  input.disabled = false;
  if (!data.ok) {
    status.textContent = `Failed: ${data.error}`;
    return;
  }
  text.textContent = data.text;
  status.textContent = `Done in worker (DOM: ${data.dom}): ${data.images
    .map((image) => `${image.width}×${image.height} PNG ${image.bytes > 0 ? 'ok' : 'empty'}`)
    .join(', ')}`;
};
worker.onerror = (event) => {
  input.disabled = false;
  status.textContent = `Failed: ${event.message}`;
};
input.onchange = async () => {
  const file = input.files?.[0];
  if (!file) return;
  input.disabled = true;
  status.textContent = 'Extracting in worker…';
  text.textContent = '';
  // Transfer the bytes; the worker owns them from here on.
  const request: ExtractRequest = {
    pdf: await file.arrayBuffer(),
    ocr: mode.value as ExtractRequest['ocr'],
  };
  worker.postMessage(request, [request.pdf]);
};
