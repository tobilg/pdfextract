import { defineConfig } from 'vite';
export default defineConfig({
  base: '/pdfextract-demo/',
  server: { host: '127.0.0.1', port: 4173, strictPort: true },
  build: { outDir: 'dist' },
  optimizeDeps: { exclude: ['@pdfextract/core', '@pdfextract/ocr', '@pdfextract/storage'] },
});
