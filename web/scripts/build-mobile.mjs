import { build } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSettings } from '../build-config.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const settings = buildSettings(process.env);
const output = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(directory, '../../server/public/app');
const mobileBase = `${settings.productPublicBaseWithSlash}mobile/`;
await build({ configFile: path.resolve(directory, '../mobile-design/vite.config.mjs'),
  base: mobileBase, define: { __PRODUCT_API_BASE__: JSON.stringify(settings.productApiBase) },
  build: { outDir: path.join(output, 'mobile'), emptyOutDir: true },
});
// Keep the previously shared prototype entry usable, without a second stale app.
const legacy = path.join(output, 'mobile-design'); fs.mkdirSync(legacy, { recursive: true });
fs.writeFileSync(path.join(legacy, 'index.html'), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="0;url=${mobileBase}index.html#/discover"><title>职路 · 移动求职</title></head><body><p>手机端已升级，正在打开。</p><a href="${mobileBase}index.html#/discover">打开职路手机端</a></body></html>`);
