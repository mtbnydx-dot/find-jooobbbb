'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function profileDirectory(dataDir, profile) {
  const safe = String(profile || 'default').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'default';
  const directory = path.join(dataDir, 'browser-profiles', safe);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function requirePlaywright() {
  try { return require('playwright'); } catch (_) {
    throw new Error('浏览器组件未安装，请在 server 目录执行 npm ci && npx playwright install --with-deps chromium');
  }
}

async function launchContext(source, dataDir, { headless = true } = {}) {
  const { chromium } = requirePlaywright();
  return chromium.launchPersistentContext(profileDirectory(dataDir, source.authProfile), {
    headless,
    viewport: { width: 1440, height: 960 },
    locale: 'zh-CN',
    timezoneId: 'Australia/Brisbane',
    acceptDownloads: true,
    args: ['--disable-dev-shm-usage'],
  });
}

async function gotoSource(page, source) {
  await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: Number(source.config?.navigationTimeoutMs || 90_000) });
  await page.waitForTimeout(Number(source.config?.settleMs || 3_000));
}

function recordsFromJson(data) {
  if (Array.isArray(data)) return data;
  for (const key of ['records', 'rows', 'jobs', 'data', 'items', 'list']) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  if (Array.isArray(data?.data?.records)) return data.data.records;
  throw new Error('JSON 中未找到数组；支持 records/rows/jobs/data/items/list');
}

async function fetchJsonSource(source) {
  const response = await fetch(source.url, { signal: AbortSignal.timeout(Number(source.config?.timeoutMs || 60_000)) });
  if (!response.ok) throw new Error(`JSON 下载失败：HTTP ${response.status}`);
  return recordsFromJson(await response.json());
}

async function fetchXlsxSource(source) {
  const XLSX = require('xlsx');
  const response = await fetch(source.url, { signal: AbortSignal.timeout(Number(source.config?.timeoutMs || 90_000)) });
  if (!response.ok) throw new Error(`表格下载失败：HTTP ${response.status}`);
  const workbook = XLSX.read(Buffer.from(await response.arrayBuffer()), { type: 'buffer', cellDates: false });
  const sheetName = source.sheetName || workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error(`找不到工作表：${sheetName}`);
  return XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
}

async function extractHtmlTables(page, source) {
  const selector = String(source.config?.tableSelector || 'table');
  const tables = page.locator(selector);
  const count = await tables.count();
  if (!count) return [];
  const tableIndex = Math.max(0, Math.min(count - 1, Number(source.config?.tableIndex || 0)));
  return tables.nth(tableIndex).evaluate(table => {
    const rows = [...table.querySelectorAll('tr')].map(row => [...row.querySelectorAll('th,td')].map(cell => (cell.innerText || cell.textContent || '').trim()));
    if (rows.length < 2) return [];
    const headers = rows[0].map((header, index) => header || `列${index + 1}`);
    return rows.slice(1).filter(row => row.some(Boolean)).map((row, rowIndex) => {
      const out = { _id: `row_${rowIndex + 1}` };
      headers.forEach((header, index) => { out[header] = row[index] || ''; });
      return out;
    });
  });
}

async function fetchHtmlSource(source, dataDir) {
  const context = await launchContext(source, dataDir);
  try {
    const page = context.pages()[0] || await context.newPage();
    await gotoSource(page, source);
    const rows = await extractHtmlTables(page, source);
    if (!rows.length) throw new Error('页面中未找到可读取的 HTML 表格');
    return rows;
  } finally {
    await context.close();
  }
}

async function fetchFeishuSource(source, dataDir) {
  const context = await launchContext(source, dataDir);
  try {
    const page = context.pages()[0] || await context.newPage();
    await gotoSource(page, source);
    const timeout = Number(source.config?.dataTimeoutMs || 120_000);
    try {
      await page.waitForFunction(tableId => {
        const store = window.bitableStore;
        const rawTables = store?.modelOperator?.base?.tables;
        const tables = Array.isArray(rawTables) ? rawTables : rawTables ? Object.values(rawTables) : [];
        const table = tableId ? tables.find(item => item?.id === tableId) : tables.find(item => item?.records && Object.keys(item.records).length);
        if (!table?.records) return false;
        const loaded = Object.keys(table.records).length;
        const expected = Number(table.recordsNum || 0);
        return loaded > 0 && (!expected || loaded >= expected) && table._status !== 'MetaLoaded' && !store.isActiveTableLoading;
      }, source.tableId || '', { timeout });
    } catch (_) {
      const visibleText = await page.locator('body').innerText().catch(() => '');
      if (/登录|扫码|验证码|sign\s*in/i.test(visibleText)) {
        const error = new Error('查看链接需要登录，请在信息源页面点击“登录”并扫码');
        error.code = 'NEEDS_LOGIN';
        throw error;
      }
      throw new Error('飞书页面已打开，但未读到多维表格数据；请检查查看权限和 tableId');
    }
    return await page.evaluate(tableId => {
      function extract(value) {
        if (value === null || value === undefined) return '';
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
        if (Array.isArray(value)) return value.map(extract).filter(Boolean).join('|');
        if (typeof value === 'object') {
          const inner = value.value;
          if (inner === undefined) return value.link || value.text || value.name || '';
          if (Array.isArray(inner)) {
            return inner.map(segment => {
              if (segment && typeof segment === 'object') return segment.link || segment.text || segment.name || '';
              return segment == null ? '' : String(segment);
            }).filter(Boolean).join(inner.some(segment => segment?.type === 'url') ? ' ' : '|');
          }
          return inner == null ? '' : String(inner);
        }
        return String(value);
      }
      const store = window.bitableStore;
      const rawTables = store?.modelOperator?.base?.tables;
      const tables = Array.isArray(rawTables) ? rawTables : Object.values(rawTables || {});
      const table = tableId ? tables.find(item => item?.id === tableId) : tables.find(item => item?.records && Object.keys(item.records).length);
      if (!table) throw new Error('table not found');
      const loaded = Object.keys(table.records || {}).length;
      const expected = Number(table.recordsNum || 0);
      if (expected && loaded < expected) throw new Error(`table data incomplete: ${loaded}/${expected}`);
      const rawFields = table.fields || {};
      const fields = Array.isArray(rawFields) ? rawFields : Object.values(rawFields);
      const fieldNames = {};
      const optionMaps = {};
      for (const field of fields) {
        if (!field?.id) continue;
        fieldNames[field.id] = field.name || field.id;
        const options = field.property?.options || field.options || [];
        optionMaps[field.id] = Object.fromEntries(options.filter(Boolean).map(option => [option.id, option.name || option.text || option.id]));
      }
      return Object.entries(table.records || {}).map(([recordId, rawRecord]) => {
        const record = rawRecord?.fields || rawRecord || {};
        const out = { _id: recordId };
        for (const [fieldId, value] of Object.entries(record)) {
          let extracted = extract(value);
          const options = optionMaps[fieldId] || {};
          if (typeof extracted === 'string' && Object.keys(options).length) {
            extracted = extracted.split('|').map(part => options[part] || part).join('|');
          }
          out[fieldNames[fieldId] || fieldId] = extracted;
        }
        return out;
      });
    }, source.tableId || '');
  } finally {
    await context.close();
  }
}

function parseTabSeparated(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n').filter(line => line.trim() !== '');
  if (lines.length < 2) return [];
  const headers = lines[0].split('\t').map((value, index) => value.trim() || `列${index + 1}`);
  return lines.slice(1).map((line, rowIndex) => {
    const cells = line.split('\t');
    const row = { _id: `row_${rowIndex + 1}` };
    headers.forEach((header, index) => { row[header] = (cells[index] || '').trim(); });
    return row;
  }).filter(row => Object.values(row).some(value => value && !String(value).startsWith('row_')));
}

function stableRecordValue(value) {
  if (Array.isArray(value)) return value.map(stableRecordValue);
  if (value && typeof value === 'object') {
    const output = {};
    for (const key of Object.keys(value).sort()) output[key] = stableRecordValue(value[key]);
    return output;
  }
  return typeof value === 'string' ? value.trim() : value;
}

function stabilizeTencentRecords(records, namespace = 'sheet') {
  const safeNamespace = String(namespace || 'sheet').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'sheet';
  const occurrences = new Map();
  return (Array.isArray(records) ? records : []).map(record => {
    const content = {};
    for (const key of Object.keys(record || {}).filter(key => !['_id', 'id'].includes(key)).sort()) {
      content[key] = stableRecordValue(record[key]);
    }
    const fingerprint = crypto.createHash('sha1').update(JSON.stringify(content), 'utf8').digest('hex').slice(0, 24);
    const occurrence = (occurrences.get(fingerprint) || 0) + 1;
    occurrences.set(fingerprint, occurrence);
    const suffix = occurrence > 1 ? `:duplicate_${occurrence}` : '';
    return { ...record, _id: `${safeNamespace}:content_${fingerprint}${suffix}` };
  });
}

function tencentNamespace(source) {
  if (source?.tableId) return source.tableId;
  try { return new URL(source?.url || '').searchParams.get('tab') || source?.sheetName || 'sheet'; } catch (_) { return source?.sheetName || 'sheet'; }
}

function recordsFromTencentGrid(grid) {
  const rawHeaders = Array.isArray(grid?.headers) ? grid.headers : [];
  const headers = [];
  const seen = new Map();
  for (let index = 0; index < rawHeaders.length; index++) {
    const base = String(rawHeaders[index] || '').trim() || `列${index + 1}`;
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    headers.push(count === 1 ? base : `${base}_${count}`);
  }
  if (!headers.length) return [];
  const records = (Array.isArray(grid?.rows) ? grid.rows : []).map((entry, rowIndex) => {
    const values = Array.isArray(entry?.values) ? entry.values : Array.isArray(entry) ? entry : [];
    const sourceRow = Number.isInteger(entry?.rowIndex) ? entry.rowIndex + 1 : rowIndex + 1;
    const out = { _id: `${grid.sheetId || 'sheet'}:row_${sourceRow}` };
    headers.forEach((header, index) => { out[header] = String(values[index] ?? '').trim(); });
    return out;
  }).filter(row => headers.some(header => row[header]));
  return stabilizeTencentRecords(records, grid?.sheetId || grid?.sheetName || 'sheet');
}

async function extractTencentWorkbook(page, source) {
  let urlSheetId = '';
  try { urlSheetId = new URL(source.url).searchParams.get('tab') || ''; } catch (_) { /* invalid URL handled by navigation */ }
  const sheetId = String(source.tableId || urlSheetId || '');
  const sheetName = String(source.sheetName || '');
  const timeout = Number(source.config?.dataTimeoutMs || 45_000);
  try {
    await page.waitForFunction(({ sheetId, sheetName }) => {
      if (!window.SpreadsheetAppInitComplete) return false;
      const manager = window.SpreadsheetApp?.workbook?.worksheetManager;
      const sheets = manager?.sheetList || [];
      if (!sheets.length) return false;
      return !sheetId && !sheetName || sheets.some(sheet =>
        String(sheet?._KL || '') === sheetId || String(sheet?._AnT || '') === sheetName
      );
    }, { sheetId, sheetName }, { timeout });
  } catch (_) {
    return [];
  }

  // Tencent loads its compressed row blocks after the workbook object becomes available.
  // A short fixed settle avoids returning only the first visible viewport from large sheets.
  await page.waitForTimeout(Number(source.config?.dataSettleMs || 8_000));
  const grid = await page.evaluate(({ sheetId, sheetName, config }) => {
    const manager = window.SpreadsheetApp?.workbook?.worksheetManager;
    const sheets = manager?.sheetList || [];
    let sheet = sheets.find(item => String(item?._KL || '') === sheetId);
    if (!sheet && sheetName) sheet = sheets.find(item => String(item?._AnT || '') === sheetName);
    if (!sheet) sheet = manager?.activeSheet || sheets[0];
    if (!sheet) return null;

    function rawValue(cell) {
      try { return cell?.getValue?.() ?? cell?.value; } catch (_) { return cell?.value; }
    }

    function hyperlinks(value) {
      if (!value || typeof value !== 'object') return [];
      const segments = Array.isArray(value.r) ? value.r : [];
      return [...new Set(segments.map(segment => segment?.hyperlink?.url || '').filter(Boolean))];
    }

    function text(value) {
      if (value === null || value === undefined) return '';
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
      if (Array.isArray(value)) return value.map(text).filter(Boolean).join(' ');
      if (typeof value === 'object') {
        if (Array.isArray(value.r)) return value.r.map(segment => text(segment?.t ?? segment?.text ?? segment)).filter(Boolean).join('');
        for (const key of ['value', 'text', 'displayValue', 'name', 'url', 'link', 'href']) {
          const extracted = text(value[key]);
          if (extracted) return extracted;
        }
      }
      return '';
    }

    function cellText(row, col) {
      let cell;
      try { cell = sheet.getCellDataAtPosition(row, col, false); } catch (_) { return ''; }
      if (!cell) return '';
      const raw = rawValue(cell);
      const links = hyperlinks(raw);
      if (links.length) return links.join(' ');
      try {
        const formatted = text(cell.getFormattedValue?.() ?? cell.formattedValue);
        if (formatted) return formatted;
      } catch (_) { /* raw value fallback below */ }
      return text(raw);
    }

    const clamp = (value, fallback, min, max) => Math.max(min, Math.min(max, Number(value) || fallback));
    const rowCount = Math.min(Number(sheet.getRowCount?.() || sheet._Md || 0), clamp(config.maxRows, 50_000, 1, 100_000));
    const colCount = Math.min(Number(sheet.getColCount?.() || sheet._MD || 0), clamp(config.maxColumns, 256, 1, 1_024));
    if (!rowCount || !colCount) return null;

    const aliases = new Set([
      '公司', '公司名称', '行业', '行业大类', '性质', '企业性质', '录入时间', '更新时间', '申请截止', '截止时间',
      '岗位', '招聘岗位', '地点', '工作地点', '应届生', '招聘对象', '学历', '公告链接', '官方公告', '网申链接/邮箱',
      '投递方式', '批次', '是否需要笔试', '备注/提示',
    ]);
    let headerRow;
    if (Number.isInteger(Number(config.headerRowIndex)) && Number(config.headerRowIndex) >= 0) {
      headerRow = Number(config.headerRowIndex);
    } else if (Number(config.headerRow) > 0) {
      headerRow = Number(config.headerRow) - 1;
    } else {
      const scanRows = Math.min(rowCount, clamp(config.headerScanRows, 40, 1, 200));
      let bestScore = -1;
      headerRow = 0;
      for (let row = 0; row < scanRows; row++) {
        let nonEmpty = 0;
        let matches = 0;
        for (let col = 0; col < colCount; col++) {
          const value = cellText(row, col).trim();
          if (!value) continue;
          nonEmpty++;
          if (aliases.has(value)) matches++;
        }
        const score = matches * 1_000 + Math.min(nonEmpty, 999);
        if (score > bestScore) {
          bestScore = score;
          headerRow = row;
        }
      }
    }
    if (headerRow < 0 || headerRow >= rowCount) return null;

    const columnIndexes = [];
    const headers = [];
    for (let col = 0; col < colCount; col++) {
      const header = cellText(headerRow, col).trim();
      if (!header) continue;
      columnIndexes.push(col);
      headers.push(header);
    }
    if (!headers.length) return null;

    const rows = [];
    for (let row = headerRow + 1; row < rowCount; row++) {
      const values = columnIndexes.map(col => cellText(row, col));
      if (values.some(Boolean)) rows.push({ rowIndex: row, values });
    }
    return {
      sheetId: String(sheet?._KL || sheetId || ''),
      sheetName: String(sheet?._AnT || sheetName || ''),
      headerRow,
      headers,
      rows,
    };
  }, { sheetId, sheetName, config: source.config || {} });
  return recordsFromTencentGrid(grid);
}

function decodeXml(value) {
  return String(value || '')
    .replace(/^<!\[CDATA\[|\]\]>$/g, '')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code) => String.fromCodePoint(code[0].toLowerCase() === 'x' ? Number.parseInt(code.slice(1), 16) : Number.parseInt(code, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function isExperienceUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return /(^|\.)(nowcoder\.com|kanzhun\.com)$/.test(hostname);
  } catch (_) {
    return false;
  }
}

function parseDuckDuckGoHtml(html) {
  const snippets = [...String(html || '').matchAll(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)]
    .map(match => decodeXml(match[1]).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  const results = [];
  const anchors = String(html || '').match(/<a\b[\s\S]*?<\/a>/gi) || [];
  for (const anchor of anchors) {
    if (!/class="[^"]*result__a[^"]*"/i.test(anchor)) continue;
    const href = decodeXml(/href="([^"]+)"/i.exec(anchor)?.[1] || '');
    const title = decodeXml(anchor.replace(/^<a\b[^>]*>|<\/a>$/gi, '')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    let target = href;
    try {
      const redirect = new URL(href.startsWith('//') ? `https:${href}` : href);
      target = redirect.searchParams.get('uddg') || redirect.href;
    } catch (_) { continue; }
    if (!title || !isExperienceUrl(target)) continue;
    results.push({ title, url: target, snippet: snippets[results.length] || '' });
    if (results.length >= 8) break;
  }
  return results;
}

function parseBingRss(xml) {
  const items = String(xml || '').match(/<item>[\s\S]*?<\/item>/gi) || [];
  const tag = (item, name) => {
    const match = new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, 'i').exec(item);
    return decodeXml(match?.[1] || '');
  };
  const results = [];
  for (const item of items) {
    const title = tag(item, 'title').replace(/<[^>]+>/g, '').trim();
    const url = tag(item, 'link').trim();
    const snippet = tag(item, 'description').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!isExperienceUrl(url) || !title) continue;
    results.push({ title, url, snippet });
    if (results.length >= 8) break;
  }
  return results;
}

async function fetchTencentSource(source, dataDir) {
  const context = await launchContext(source, dataDir);
  try {
    const page = context.pages()[0] || await context.newPage();
    await gotoSource(page, source);
    const initialBody = await page.locator('body').innerText().catch(() => '');
    if (/此文档已设置权限[\s\S]{0,80}登录|立即登录|微信扫码|QQ扫码|验证码/i.test(initialBody)) {
      const error = new Error('腾讯文档需要登录，请在信息源页面点击“登录”并扫码');
      error.code = 'NEEDS_LOGIN';
      throw error;
    }
    const domRows = await extractHtmlTables(page, source);
    if (domRows.length) return stabilizeTencentRecords(domRows, tencentNamespace(source));

    const workbookRows = await extractTencentWorkbook(page, source);
    if (workbookRows.length) return workbookRows;

    const origin = new URL(source.url).origin;
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin }).catch(() => {});
    await page.locator(String(source.config?.gridSelector || 'body')).first().click({ position: { x: 300, y: 300 }, timeout: 10_000 }).catch(() => {});
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+C' : 'Control+C');
    await page.waitForTimeout(800);
    const copied = await page.evaluate(() => navigator.clipboard?.readText?.()).catch(() => '');
    const rows = parseTabSeparated(copied);
    if (rows.length) return stabilizeTencentRecords(rows, tencentNamespace(source));

    const body = await page.locator('body').innerText().catch(() => '');
    if (/登录|微信扫码|QQ扫码|验证码/i.test(body)) {
      const error = new Error('腾讯文档需要登录，请在信息源页面点击“登录”并扫码');
      error.code = 'NEEDS_LOGIN';
      throw error;
    }
    throw new Error('腾讯文档已打开，但无法读取整表；请确认查看链接允许复制或导出');
  } finally {
    await context.close();
  }
}

async function fetchSource(source, { dataDir } = {}) {
  if (!source?.id) throw new Error('信息源配置缺少 id');
  if (!dataDir) throw new Error('采集器缺少 dataDir');
  if (source.kind === 'json') return fetchJsonSource(source);
  if (source.kind === 'xlsx') return fetchXlsxSource(source);
  if (source.kind === 'html') return fetchHtmlSource(source, dataDir);
  if (source.kind === 'feishu') return fetchFeishuSource(source, dataDir);
  if (source.kind === 'tencent') return fetchTencentSource(source, dataDir);
  throw new Error(`暂不支持来源类型：${source.kind}`);
}

async function createLoginSession(source, { dataDir } = {}) {
  const context = await launchContext(source, dataDir);
  const page = context.pages()[0] || await context.newPage();
  await gotoSource(page, source);

  async function clickVisibleText(labels, { reverse = false } = {}) {
    for (const label of labels) {
      const candidates = page.getByText(label, { exact: true });
      const count = await candidates.count().catch(() => 0);
      const indexes = [...Array(count).keys()];
      if (reverse) indexes.reverse();
      for (const index of indexes) {
        const candidate = candidates.nth(index);
        if (!await candidate.isVisible().catch(() => false)) continue;
        try {
          await candidate.click({ timeout: 5_000, noWaitAfter: true });
          return true;
        } catch (_) { /* try the next exact match */ }
      }
    }
    return false;
  }

  await clickVisibleText(['立即登录', '扫码登录', '微信登录', 'QQ登录', '登录']);
  await page.waitForTimeout(800);

  // Tencent first opens a login-method dialog. It requires accepting the displayed terms and a
  // second click before the actual WeChat/QQ QR code is rendered.
  if (source.kind === 'tencent') {
    const agreement = page.locator('input[type="checkbox"]').last();
    if (await agreement.isVisible().catch(() => false)) await agreement.check({ force: true }).catch(() => {});
    await clickVisibleText(['立即登录'], { reverse: true });
    await page.waitForTimeout(1_500);
  }
  return {
    createdAt: Date.now(),
    async screenshot() { return page.screenshot({ type: 'png' }); },
    async status() {
      if (page.isClosed()) return { status: 'closed', message: '登录窗口已关闭' };
      const body = await page.locator('body').innerText().catch(() => '');
      const needsLogin = /登录|扫码|验证码|sign\s*in/i.test(body);
      return { status: needsLogin ? 'waiting' : 'ready', message: needsLogin ? '请扫码或完成页面登录' : '登录状态已保存，可以关闭窗口' };
    },
    async close() { await context.close(); },
  };
}

async function searchInterviewExperience(company, { dataDir, authProfile = 'research' } = {}) {
  const query = `${company} 校招 面经 牛客 看准`;
  try {
    const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobTracker/2.0)' },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok) {
      const results = parseDuckDuckGoHtml(await response.text());
      if (results.length) return results;
    }
  } catch (_) { /* Bing fallback below */ }
  try {
    const response = await fetch(`https://cn.bing.com/search?format=rss&q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobTracker/2.0)' },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok) {
      const results = parseBingRss(await response.text());
      if (results.length) return results;
    }
  } catch (_) { /* browser fallback below */ }
  const source = { authProfile, config: {} };
  const context = await launchContext(source, dataDir);
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(`https://cn.bing.com/search?q=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(1500);
    const results = await page.locator('li.b_algo').evaluateAll(items => items.slice(0, 12).map(item => {
      const link = item.querySelector('h2 a');
      const snippet = item.querySelector('.b_caption p, .b_snippet');
      return { title: (link?.textContent || '').trim(), url: link?.href || '', snippet: (snippet?.textContent || '').trim() };
    }).filter(item => item.title && /^https?:/.test(item.url)));
    return results.filter(item => isExperienceUrl(item.url)).slice(0, 8);
  } finally {
    await context.close();
  }
}

module.exports = {
  fetchSource,
  fetchFeishuSource,
  fetchTencentSource,
  parseTabSeparated,
  recordsFromTencentGrid,
  stabilizeTencentRecords,
  parseDuckDuckGoHtml,
  parseBingRss,
  createLoginSession,
  searchInterviewExperience,
};
