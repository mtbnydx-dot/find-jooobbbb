import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSettings } from '../build-config.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const settings = buildSettings(process.env);
const outputDirectory = path.resolve(directory, '../../server/public/app');
const indexFile = path.join(outputDirectory, 'index.html');
const workerFile = path.join(outputDirectory, 'sw.js');
const html = fs.readFileSync(indexFile, 'utf8');
const assetPrefix = `${settings.productPublicBaseWithSlash}assets/`;
const assets = [...new Set([...html.matchAll(/(?:src|href)="([^"]*\/assets\/[^"]+)"/g)]
  .map(match => match[1])
  .filter(asset => asset.startsWith(assetPrefix)))].sort();

if (!assets.length) throw new Error('构建产物中没有找到需要预缓存的 JS/CSS 资源');

const buildId = crypto.createHash('sha256').update(assets.join('\n')).digest('hex').slice(0, 12);
const entries = assets.map(asset => `  ${JSON.stringify(asset)},`).join('\n');
const source = fs.readFileSync(workerFile, 'utf8');
if (!source.includes('/*__BUILD_ASSETS__*/') || !source.includes('__BUILD_ID__')) {
  throw new Error('service worker 缺少构建注入占位符');
}
fs.writeFileSync(workerFile, source
  .replace('/*__BUILD_ASSETS__*/', entries)
  .replace('__BUILD_ID__', buildId));
