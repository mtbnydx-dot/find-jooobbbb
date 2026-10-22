import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: process.env.MOBILE_DESIGN_BASE || '/mobile-design/',
  plugins: [react()],
  server: { host: '127.0.0.1', port: 4185, strictPort: true },
  preview: { host: '127.0.0.1', port: 4186, strictPort: true },
  build: { outDir: process.env.MOBILE_DESIGN_OUT_DIR || 'dist', emptyOutDir: false },
});
