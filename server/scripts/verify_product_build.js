'use strict';

const fs = require('node:fs');
const path = require('node:path');

function normalizePublicBase(value = '/app') {
  let result = String(value || '/app').trim();
  if (!result.startsWith('/')) result = `/${result}`;
  result = result.replace(/\/{2,}/g, '/');
  if (result.length > 1) result = result.replace(/\/+$/, '');
  if (!result || /[?#\\]/.test(result) || result.split('/').includes('..')) {
    throw new Error('PRODUCT_PUBLIC_BASE 必须是站点内的绝对路径');
  }
  return result;
}

function requireFile(file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`缺少产品构建文件：${file}`);
  return fs.readFileSync(file, 'utf8');
}

function verifyProductBuild(root = path.resolve(__dirname, '..', 'public', 'app'), {
  publicBase = process.env.PRODUCT_PUBLIC_BASE || '/app',
} = {}) {
  const normalizedBase = normalizePublicBase(publicBase);
  const baseWithSlash = normalizedBase === '/' ? '/' : `${normalizedBase}/`;
  const indexFile = path.join(root, 'index.html');
  const serviceWorkerFile = path.join(root, 'sw.js');
  const manifestFile = path.join(root, 'manifest.webmanifest');
  const index = requireFile(indexFile);
  const serviceWorker = requireFile(serviceWorkerFile);
  const manifest = JSON.parse(requireFile(manifestFile));
  const assetPaths = [...index.matchAll(/(?:src|href)="([^"]*\/assets\/[^"]+)"/g)]
    .map(match => match[1])
    .filter(assetPath => assetPath.startsWith(`${baseWithSlash}assets/`));
  if (!assetPaths.some(value => /\.js$/.test(value)) || !assetPaths.some(value => /\.css$/.test(value))) {
    throw new Error('产品 index.html 未引用带哈希的 JS/CSS 资产');
  }
  for (const assetPath of assetPaths) {
    const relative = assetPath.slice(baseWithSlash.length);
    requireFile(path.join(root, ...relative.split('/')));
    if (!serviceWorker.includes(assetPath)) throw new Error(`Service worker 未预缓存当前资产：${assetPath}`);
  }
  const resolveManifestPath = value => {
    const resolved = new URL(String(value || ''), `https://product.invalid${baseWithSlash}`).pathname;
    if (!resolved.startsWith(baseWithSlash)) throw new Error(`manifest 路径超出产品基址：${value}`);
    return resolved.slice(baseWithSlash.length);
  };
  for (const icon of manifest.icons || []) {
    const relative = resolveManifestPath(icon.src);
    if (relative) requireFile(path.join(root, ...relative.split('/')));
  }
  for (const field of ['id', 'start_url', 'scope']) resolveManifestPath(manifest[field]);
  if (!serviceWorker.includes('CACHE_PREFIX') || !serviceWorker.includes('self.registration.scope')) {
    throw new Error('Service worker 必须按部署基址隔离 scope 与缓存');
  }
  return { root, publicBase: normalizedBase, assets: assetPaths.length, icons: manifest.icons?.length || 0 };
}

if (require.main === module) {
  const result = verifyProductBuild();
  process.stdout.write(`产品构建校验通过：${result.publicBase}，${result.assets} 个哈希资产，${result.icons} 个 manifest 图标。\n`);
}

module.exports = { verifyProductBuild };
