import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/app/',
  plugins: [react()],
  build: {
    outDir: '../server/public/app',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 4173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:3000',
    },
  },
});
