'use strict';

const fs = require('node:fs');
const path = require('node:path');

function requireFile(file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`缺少产品构建文件：${file}`);
  return fs.readFileSync(file, 'utf8');
}

function verifyProductBuild(root = path.resolve(__dirname, '..', 'public', 'app')) {
  const indexFile = path.join(root, 'index.html');
  const serviceWorkerFile = path.join(root, 'sw.js');
  const manifestFile = path.join(root, 'manifest.webmanifest');
  const index = requireFile(indexFile);
  const serviceWorker = requireFile(serviceWorkerFile);
  const manifest = JSON.parse(requireFile(manifestFile));
  const assetPaths = [...index.matchAll(/(?:src|href)="(\/app\/assets\/[^"]+)"/g)].map(match => match[1]);
  if (!assetPaths.some(value => /\.js$/.test(value)) || !assetPaths.some(value => /\.css$/.test(value))) {
    throw new Error('产品 index.html 未引用带哈希的 JS/CSS 资产');
  }
  for (const assetPath of assetPaths) {
    const relative = assetPath.replace(/^\/app\//, '');
    requireFile(path.join(root, ...relative.split('/')));
    if (!serviceWorker.includes(assetPath)) throw new Error(`Service worker 未预缓存当前资产：${assetPath}`);
  }
  for (const icon of manifest.icons || []) {
    const relative = String(icon.src || '').replace(/^\/app\//, '');
    if (relative) requireFile(path.join(root, ...relative.split('/')));
  }
  if (!String(manifest.start_url || '').startsWith('/app/')) throw new Error('PWA start_url 必须位于 /app/');
  return { root, assets: assetPaths.length, icons: manifest.icons?.length || 0 };
}

if (require.main === module) {
  const result = verifyProductBuild();
  process.stdout.write(`产品构建校验通过：${result.assets} 个哈希资产，${result.icons} 个 manifest 图标。\n`);
}

module.exports = { verifyProductBuild };
