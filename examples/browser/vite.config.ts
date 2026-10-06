import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
export default defineConfig({
  base: '/pdfextract-demo/',
  server: { host: '127.0.0.1', port: 4173, strictPort: true },
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        worker: fileURLToPath(new URL('./worker.html', import.meta.url)),
      },
    },
  },
  // The extraction worker is a module worker so it can lazily import the engine assets.
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@pdfextract/core', '@pdfextract/ocr', '@pdfextract/storage'] },
});
