import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { mobilePwa } from './mobile-pwa.mjs';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: process.env.MOBILE_DESIGN_BASE || '/mobile-design/',
  plugins: [react(), mobilePwa()],
  define: { __PRODUCT_API_BASE__: JSON.stringify(process.env.MOBILE_API_BASE || '/api/v1') },
  server: { host: '127.0.0.1', port: 4185, strictPort: true,
    proxy: { [process.env.MOBILE_API_BASE || '/api/v1']: {
      target: process.env.MOBILE_API_TARGET || 'http://127.0.0.1:3320', changeOrigin: false,
    } },
  },
  preview: { host: '127.0.0.1', port: 4186, strictPort: true },
  build: { target: ['es2020', 'safari15', 'chrome96', 'firefox100'], outDir: process.env.MOBILE_DESIGN_OUT_DIR || 'dist', emptyOutDir: false },
});
