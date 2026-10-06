import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs also work when the verified build is hosted below a path prefix.
  base: './',
  plugins: [react()],
  optimizeDeps: { exclude: ['@pdfextract/core', '@pdfextract/ocr'] },
  build: { target: 'es2022' },
});
