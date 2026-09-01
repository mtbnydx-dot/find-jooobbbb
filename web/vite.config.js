import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { buildSettings } from './build-config.mjs';

export default defineConfig(() => {
  const settings = buildSettings(process.env);
  return {
    base: settings.productPublicBaseWithSlash,
    define: {
      __PRODUCT_API_BASE__: JSON.stringify(settings.productApiBase),
      __OPS_PUBLIC_BASE__: JSON.stringify(settings.opsPublicBase),
    },
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
        [settings.productApiBase]: {
          target: 'http://127.0.0.1:3000',
          rewrite: requestPath => settings.productApiBase === '/api/v1'
            ? requestPath
            : `/api/v1${requestPath.slice(settings.productApiBase.length)}`,
        },
      },
    },
  };
});
