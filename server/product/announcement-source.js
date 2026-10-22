'use strict';

// Public announcements only. Fetching and extraction never execute page scripts,
// use logged-in cookies, or treat a transport error as evidence of a closed job.
const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const { deadlineFact } = require('../cloud/job-facts');

const AGENT = 'ZhiluJobEvidence/1.0';
const VERSION = 'announcement-evidence-v1';
const MAX_BYTES = 2 * 1024 * 1024;
const robotsCache = new Map();
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const compact = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
const clean = value => String(value || '').replace(/[ \t]+/g, ' ').trim();

function canonicalAnnouncementUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 3000) return '';
    if (url.port && !['80', '443'].includes(url.port)) return '';
    for (const key of [...url.searchParams.keys()]) if (/^utm_/i.test(key)) url.searchParams.delete(key);
    // Hash routes can identify distinct jobs on SPA sites; do not erase them.
    url.searchParams.sort();
    return url.href;
  } catch { return ''; }
}

function publicAddress(address) {
  let value = String(address).toLowerCase().replace(/^\[|\]$/g, '');
  if (value.startsWith('::ffff:')) value = value.slice(7);
  if (net.isIP(value) === 4) {
    const [a, b] = value.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) || (a === 198 && [18, 19].includes(b)));
  }
  if (net.isIP(value) === 6) return !/^(::|fc|fd|fe[89ab]|ff)/i.test(value);
  return false;
}

async function validateDestination(value, resolve = dns.lookup) {
  const canonical = canonicalAnnouncementUrl(value);
  if (!canonical) throw new Error('INVALID_PUBLIC_URL');
  const url = new URL(canonical), hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname.includes('.') && !net.isIP(hostname) || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/i.test(hostname)) throw new Error('NON_PUBLIC_DESTINATION');
  const addresses = net.isIP(hostname) ? [{ address: hostname, family: net.isIP(hostname) }] : await resolve(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('NON_PUBLIC_DESTINATION');
  return { url, addresses };
}

function requestOnce(url, { addresses, signal, timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'GET', signal,
      headers: { 'User-Agent': AGENT, Accept: 'text/html,application/ld+json,text/plain;q=0.8', 'Accept-Encoding': 'identity' },
      // Pin the validated resolution for this connection, including redirects.
      lookup: (_name, options, done) => options.all ? done(null, addresses) : done(null, addresses[0].address, addresses[0].family),
    }, response => {
      const chunks = []; let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) { response.destroy(); request.destroy(new Error('RESPONSE_TOO_LARGE')); }
        else chunks.push(chunk);
      });
      response.on('end', () => resolve({ statusCode: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on('error', reject);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('FETCH_TIMEOUT')));
    request.on('error', reject); request.end();
  });
}

async function download(value, options) {
  let current = value;
  for (let redirects = 0; redirects <= 4; redirects++) {
    const destination = await validateDestination(current, options.resolve);
    const response = await options.requestImpl(destination.url, { ...options, addresses: destination.addresses });
    if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
      const target = new URL(response.headers.location, destination.url);
      // Stop before contacting a second origin: its robots policy has not been read.
      if (target.origin !== destination.url.origin) return { ...response, finalUrl: target.href, externalRedirect: true };
      current = target.href; continue;
    }
    return { ...response, finalUrl: destination.url.href };
  }
  throw new Error('TOO_MANY_REDIRECTS');
}

function decodeBody(response, maxBytes) {
  let data = Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.body || '');
  const encoding = String(response.headers['content-encoding'] || '').toLowerCase();
  if (encoding === 'gzip') data = zlib.gunzipSync(data, { maxOutputLength: maxBytes });
  else if (encoding === 'br') data = zlib.brotliDecompressSync(data, { maxOutputLength: maxBytes });
  else if (encoding === 'deflate') data = zlib.inflateSync(data, { maxOutputLength: maxBytes });
  if (data.length > maxBytes) throw new Error('RESPONSE_TOO_LARGE');
  const charset = /charset\s*=\s*["']?([\w-]+)/i.exec(String(response.headers['content-type'] || '') + ' ' + data.subarray(0, 3000).toString('ascii'))?.[1] || 'utf-8';
  try { return new TextDecoder(charset).decode(data); } catch { return new TextDecoder('utf-8').decode(data); }
}

function robotsAllowed(text, url) {
  const groups = []; let group = { agents: [], rules: [] };
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^\s*(user-agent|allow|disallow)\s*:\s*([^#]*)/i.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase(), value = match[2].trim();
    if (key === 'user-agent') {
      if (group.rules.length) { groups.push(group); group = { agents: [], rules: [] }; }
      group.agents.push(value.toLowerCase());
    } else if (value) group.rules.push({ allow: key === 'allow', path: value });
  }
  groups.push(group);
  const specific = groups.filter(item => item.agents.some(agent => agent !== '*' && AGENT.toLowerCase().includes(agent)));
  const applicable = specific.length ? specific : groups.filter(item => item.agents.includes('*'));
  const target = new URL(url).pathname + new URL(url).search;
  const matching = applicable.flatMap(item => item.rules).filter(rule => {
    const pattern = rule.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$');
    return new RegExp('^' + pattern).test(target);
  }).sort((a, b) => b.path.length - a.path.length || Number(b.allow) - Number(a.allow));
  return !matching.length || matching[0].allow;
}

async function fetchAnnouncement(value, input = {}) {
  const options = { resolve: dns.lookup, requestImpl: requestOnce, maxBytes: MAX_BYTES, timeoutMs: 15000, ...input };
  const checkedAt = new Date(options.now ?? Date.now()).toISOString();
  const url = canonicalAnnouncementUrl(value);
  const result = { url, finalUrl: url, checkedAt, statusCode: 0, html: '', text: '', contentType: '', contentHash: '', accessStatus: 'unavailable' };
  if (!url) return { ...result, reason: '链接不是受支持的公开网页地址' };
  try {
    const origin = new URL(url).origin;
    // Test transports do not share a live robots cache with other runs.
    let robots = !input.requestImpl && robotsCache.get(origin);
    if (!robots || robots.until < Date.now()) {
      const response = await download(origin + '/robots.txt', { ...options, maxBytes: 128 * 1024 });
      if (response.externalRedirect) return { ...result, accessStatus: 'blocked', reason: '站点抓取规则跳转到其他站点，需人工查看' };
      if (![200, 404, 410].includes(response.statusCode)) return { ...result, accessStatus: 'blocked', reason: '站点抓取规则不可读取，需人工查看' };
      robots = { text: response.statusCode === 200 ? decodeBody(response, 128 * 1024) : '', until: Date.now() + 3600000 };
      if (!input.requestImpl) { if (robotsCache.size >= 300) robotsCache.delete(robotsCache.keys().next().value); robotsCache.set(origin, robots); }
    }
    if (!robotsAllowed(robots.text, url)) return { ...result, accessStatus: 'blocked', reason: '站点 robots 规则不允许抓取该公告' };
    const response = await download(url, options);
    Object.assign(result, { finalUrl: response.finalUrl, statusCode: response.statusCode, contentType: String(response.headers['content-type'] || '') });
    // A cross-origin redirect has its own crawling rules. Do not silently follow
    // into another company's site; the operator can check that exact URL instead.
    if (new URL(response.finalUrl).origin !== origin) return { ...result, accessStatus: 'unsupported', reason: '公告跳转到其他站点，请核对最终链接后重试' };
    if ([401, 403, 429].includes(response.statusCode)) return { ...result, accessStatus: 'blocked', reason: '站点限制访问；不会绕过登录或验证码' };
    if (response.statusCode < 200 || response.statusCode >= 300) return { ...result, reason: `公告访问返回 ${response.statusCode}，不能据此判断停招` };
    if (!/(text\/html|application\/xhtml|text\/plain|application\/ld\+json)/i.test(result.contentType)) return { ...result, accessStatus: 'unsupported', reason: '附件或非网页内容需人工核验，尚未提取' };
    result.html = decodeBody(response, options.maxBytes);
    result.text = htmlText(result.html);
    result.contentHash = hash(result.html);
    const title = htmlText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(result.html)?.[1] || '');
    if (/验证码|安全验证|captcha|access denied|just a moment|verify.*human/i.test(title) || (result.text.length < 1000 && /扫码登录|请先登录|登录后查看|验证您是人类|访问受限/.test(result.text))) return { ...result, html: '', text: '', accessStatus: 'blocked', reason: '页面需要授权或验证，未提取岗位事实' };
    if (result.text.length < 40 && !/JobPosting/.test(result.html)) return { ...result, accessStatus: 'unsupported', reason: '动态页面未提供可提取正文，需人工核验' };
    return { ...result, accessStatus: 'ok', parserVersion: VERSION };
  } catch (error) {
    return { ...result, reason: ['NON_PUBLIC_DESTINATION', 'INVALID_PUBLIC_URL'].includes(error.message) ? '拒绝非公开网络地址' : options.signal?.aborted ? '核验已取消' : '公告暂时无法读取；保留原信息，招聘状态未知' };
  }
}

function entities(value) {
  return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_all, token) => {
    if (token[0] === '#') { const n = token[1].toLowerCase() === 'x' ? parseInt(token.slice(2), 16) : Number(token.slice(1)); return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''; }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[token.toLowerCase()];
  });
}

function htmlText(html) {
  return entities(String(html || '').replace(/<!--[^]*?-->/g, '').replace(/<(script|style|nav|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(?:td|th)>/gi, '\t').replace(/<\/?(?:br|p|div|li|tr|h[1-6]|section)\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .replace(/[ \u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function years(value) { return new Set([...String(value || '').matchAll(/(20\d{2})\s*届/g)].map(match => match[1])); }
function identityFor(job, text, title = '', company = '') {
  const expectedYears = years(`${job.audience || ''} ${job.batch || ''}`), foundYears = years(text);
  if (expectedYears.size && foundYears.size && ![...expectedYears].some(year => foundYears.has(year))) return { level: 'none', reason: '公告与目录的毕业届次不一致，不能沿用同一链接的旧批次' };
  const expectedCompany = compact(job.company).replace(/(?:股份|有限责任|有限)公司$/u, '');
  const expectedTitle = compact(job.position);
  const multi = /[,，、;；|\n]/.test(String(job.position || ''));
  const companyMatch = expectedCompany.length >= 2 && compact(company || text).includes(expectedCompany);
  const titleMatch = expectedTitle.length >= 2 && compact(title || text).includes(expectedTitle);
  if (!companyMatch) return { level: 'none', reason: '未匹配到目录公司，需核对公告所属单位' };
  if (multi) return { level: 'ambiguous', reason: '目录合并了多个职位，不能把单个职位条件套用到全部职位' };
  if (titleMatch) return { level: 'exact', reason: '公司与单一岗位名称在公告中匹配；仍需核对原文' };
  return { level: 'company', reason: '仅匹配公司，尚不能确认条件适用于该岗位' };
}

function jsonPostings(html) {
  const out = [];
  const visit = value => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    if ([value['@type']].flat().includes('JobPosting')) out.push(value);
    if (value['@graph']) visit(value['@graph']);
  };
  for (const match of String(html || '').matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) { try { visit(JSON.parse(match[1])); } catch { /* malformed data is not evidence */ } }
  return out;
}

function roleScope(job, html, text) {
  const title = compact(job.position);
  const roleLike = value => !/职责|要求|条件|说明|福利|流程|方式|联系|介绍|提示/.test(value) && /(?:工程师|经理|专员|主管|总监|顾问|研究员|技术人员|开发人员|会计|出纳|助理|设计师|教师|医生|护士|技术员|操作员|销售代表|管培生|实习生)$/.test(value.trim());
  const headings = [...String(html).matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map(match => ({ level: Number(match[1]), value: clean(htmlText(match[2])), start: match.index, end: match.index + match[0].length }));
  const exact = headings.filter(heading => compact(heading.value.replace(/^[一二三四五六七八九十\d]+[、.．)）]\s*/, '')) === title);
  const candidates = exact.length ? exact : headings.filter(heading => compact(heading.value).includes(title));
  if (candidates.length === 1) {
    const target = candidates[0];
    const next = headings.find(heading => heading.start > target.start && heading.level <= target.level);
    const end = next?.start ?? html.length;
    const nestedRoles = headings.filter(heading => heading.start >= target.end && heading.start < end && roleLike(heading.value) && !compact(heading.value).includes(title));
    if (nestedRoles.length) return { ambiguous: true, reason: '普通公告含其他岗位小节，无法唯一确定当前岗位正文范围' };
    return { scope: htmlText(html.slice(target.end, end)), locator: `标题“${target.value.slice(0, 100)}”下的单一岗位段落` };
  }
  if (candidates.length > 1) return { ambiguous: true, reason: '普通公告有多个同名岗位标题，需人工确认适用范围' };
  const lines = text.split(/\n/).map(clean).filter(Boolean);
  const markers = lines.map((line, index) => ({ index, match: /^(?:岗位名称|职位名称|招聘岗位|岗位|职位)\s*[:：]\s*(.+)$/.exec(line) })).filter(item => item.match);
  const targets = markers.filter(item => compact(item.match[1]) === title);
  if (targets.length === 1) {
    const start = targets[0].index; const next = markers.find(item => item.index > start);
    return { scope: lines.slice(start, next?.index ?? lines.length).join('\n'), locator: '岗位名称标签至下一岗位标签之间' };
  }
  if (markers.length || lines.some(line => line.length < 80 && roleLike(line) && !compact(line).includes(title))) return { ambiguous: true, reason: '检测到多岗位信息但未定位唯一目标段落，不跨岗位提取条件' };
  // A single unstructured notice remains usable, but only literal labelled facts
  // are extracted below. Multi-role pages require a bounded heading/row/label.
  return { scope: text, locator: '单一岗位公告正文' };
}

function preciseValidThrough(value) {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d))?$/.test(value)) return null;
  const date = deadlineFact(value.slice(0, 10)).date;
  if (!date) return null;
  if (value.length === 10) return date;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? new Date(instant + 8 * 3600000).toISOString().slice(0, 10) : null;
}

function positiveClosure(line) {
  if (line.length >= 350 || /未|尚|没有|如果|假如|假设|倘|一旦|可能|是否|预计|计划|即将|将于|并非|并不|不(?:是|代表|意味|会|一定|能|停止|关闭|下线|招满)|(?:如|当).{0,16}(?:该|此|本|岗位|职位)|若|部分岗位|个别岗位|其他岗位|历史岗位|往年岗位/.test(line)) return false;
  return /(?:该|此)?(?:岗位|职位).{0,8}(?:已关闭|已下线|已招满|停止招聘)|(?:本次|本岗位)招聘已(?:结束|终止)|报名(?:已经|已)截止/.test(line);
}

function analyzeAnnouncement(input) {
  const { job, html = '', text: suppliedText, finalUrl, url, checkedAt = new Date().toISOString(), accessStatus = 'ok' } = input;
  const sourceUrl = finalUrl || url || '', text = suppliedText || htmlText(html);
  const result = { facts: {}, evidence: [], identity: { level: 'none', reason: '' }, verification: { status: 'unknown', reason: '尚无明确招聘状态证据', evidenceUrl: sourceUrl, excerpt: '', checkedAt }, status: 'needs_review', parserVersion: VERSION };
  if (accessStatus !== 'ok') return { ...result, status: ['blocked', 'unsupported'].includes(accessStatus) ? accessStatus : 'unavailable', identity: { level: 'none', reason: input.reason || '未获得公告正文' } };
  const postings = jsonPostings(html);
  const matched = postings.filter(posting => identityFor(job, htmlText(posting.description || '') + ' ' + posting.title, posting.title, posting.hiringOrganization?.name).level === 'exact');
  let scope = text, locator = '正文', method = 'explicit-labels-v1', structured;
  if (postings.length && matched.length !== 1) return { ...result, status: 'mismatch', identity: { level: 'none', reason: '结构化公告没有唯一匹配到当前公司与岗位' } };
  if (matched.length === 1) {
    structured = matched[0]; scope = htmlText(structured.description || ''); locator = 'JobPosting'; method = 'jsonld-v1';
    result.identity = identityFor(job, text, structured.title, structured.hiringOrganization?.name);
  } else result.identity = identityFor(job, text);
  if (result.identity.level === 'none') return { ...result, status: 'mismatch' };
  // Public text belonging to a multi-role or company-only announcement is retained
  // for review, but no per-role qualifications are guessed from neighbouring rows.
  if (result.identity.level !== 'exact') return result;
  if (!structured) {
    let matchedTable = false;
    for (const table of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
      const rows = [...table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(row => [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell => clean(htmlText(cell[1]))));
      const header = rows.find(row => row.some(cell => /岗位|职位/.test(cell)) && row.some(cell => /专业|经验|学历|薪/.test(cell)));
      if (!header) continue;
      const matching = rows.filter(row => row.some(cell => compact(cell) === compact(job.position)));
      if (matching.length !== 1) { result.identity = { level: 'ambiguous', reason: '公告表格存在多个同名岗位或无法唯一定位行' }; return result; }
      const companyColumn = header.findIndex(cell => /^(?:公司|公司名称|单位|单位名称|招聘单位|用人单位)$/.test(cell));
      if (companyColumn >= 0 && identityFor(job, matching[0].join(' '), job.position, matching[0][companyColumn]).level !== 'exact') { result.identity = { level: 'none', reason: '同名岗位所在表格行不是目标招聘单位' }; result.status = 'mismatch'; return result; }
      scope = matching[0].map((value, index) => `${header[index] || '字段'}：${value}`).join('\n'); locator = '岗位表中名称完全一致的一行'; method = 'table-labels-v1'; matchedTable = true; break;
    }
    if (!matchedTable) {
      const bounded = roleScope(job, html, text);
      if (bounded.ambiguous) { result.identity = { level: 'ambiguous', reason: bounded.reason }; return result; }
      scope = bounded.scope; locator = bounded.locator;
    }
  }
  const add = (fields, quote, where = locator, how = method) => {
    const valid = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== null && value !== ''));
    if (!Object.keys(valid).length || !quote) return;
    Object.assign(result.facts, valid);
    result.evidence.push({ fields: Object.keys(valid), quote: clean(htmlText(quote)).slice(0, 260), sourceUrl, locator: where, method: how });
  };
  const labels = {
    salaryText: /^(?:薪资待遇|薪酬待遇|薪资范围|薪资|薪酬|月薪|年薪|工资待遇|待遇)\s*[:：]\s*(.+)$/,
    major: /^(?:专业要求|招聘专业|所需专业|专业)\s*[:：]\s*(.+)$/,
    degree: /^(?:学历要求|最低学历|学历)\s*[:：]\s*(.+)$/,
    experience: /^(?:工作经验要求|工作经验|经验要求|经验|工作年限)\s*[:：]\s*(.+)$/,
    benefits: /^(?:福利待遇|员工福利|福利)\s*[:：]\s*(.+)$/,
  };
  const lines = scope.split(/\n/).map(clean).filter(Boolean);
  for (const [field, pattern] of Object.entries(labels)) {
    const found = lines.map(line => ({ line, match: pattern.exec(line) })).filter(item => item.match);
    const values = [...new Set(found.map(item => item.match[1].trim()))];
    if (values.length === 1) {
      const value = field === 'salaryText' && /^(?:月薪|年薪)\s*[:：]/.test(found[0].line) ? found[0].line : values[0];
      add({ [field]: value.slice(0, 1800) }, found[0].line);
    }
  }
  // Prefer literal sentences over synthesised summaries, including “不限/优先”.
  for (const [field, pattern] of [['major', /(?:相关专业|专业不限|不限专业)/], ['experience', /(?:\d+\s*年.*经验|经验.*\d+\s*年|经验不限|不限经验|无.*经验要求)/], ['degree', /(?:本科|硕士|博士|大专|专科).{0,12}(?:学历|学位|以上)/]]) {
    if (result.facts[field]) continue;
    const sentences = [...new Set(lines.flatMap(line => line.split(/[。；]/)).map(clean).filter(line => line.length < 300 && pattern.test(line)))];
    if (sentences.length === 1) add({ [field]: sentences[0] }, sentences[0]);
  }
  if (structured) {
    for (const [key, field] of [['educationRequirements', 'degree'], ['experienceRequirements', 'experience'], ['qualifications', 'requirements'], ['skills', 'skills'], ['jobBenefits', 'benefits']]) {
      const value = structured[key];
      if (typeof value === 'string') add({ [field]: htmlText(value).slice(0, 4000) }, value, `JobPosting.${key}`, 'jsonld-v1');
    }
    const salary = structured.baseSalary, amount = salary?.value;
    const currency = /^[A-Z]{3}$/.test(salary?.currency || '') ? salary.currency : '';
    const period = { HOUR: 'hour', WEEK: 'week', MONTH: 'month', YEAR: 'year' }[String(amount?.unitText || '').toUpperCase()];
    const min = Number(amount?.minValue ?? amount?.value), max = Number(amount?.maxValue ?? amount?.value);
    if (currency && period && Number.isFinite(min) && Number.isFinite(max) && min >= 0 && max >= min && max < 100000000) add({ salaryText: `${min}${max === min ? '' : '-' + max} ${currency}/${period}`, salaryMin: min, salaryMax: max, salaryCurrency: currency, salaryPeriod: period }, JSON.stringify(salary), 'JobPosting.baseSalary', 'jsonld-v1');
  }
  if (result.facts.salaryText && !result.facts.salaryCurrency) {
    const salary = result.facts.salaryText;
    const currency = /澳元|AUD|AU\$/i.test(salary) ? 'AUD' : /美元|USD|US\$/i.test(salary) ? 'USD' : /港元|港币|HKD/i.test(salary) ? 'HKD' : /人民币|CNY|RMB|(?:万|千)?元|[¥￥]/i.test(salary) ? 'CNY' : '';
    const period = /年薪|\/年|每年|年收入/.test(salary) ? 'year' : /月薪|\/月|每月/.test(salary) ? 'month' : /时薪|小时|\/时/.test(salary) ? 'hour' : /周薪|\/周/.test(salary) ? 'week' : '';
    const months = /(?:^|\D)(1[2-9]|2[0-4])\s*薪/.exec(salary)?.[1];
    add({ salaryCurrency: currency, salaryPeriod: period, salaryMonths: months ? Number(months) : undefined }, salary);
  }
  const closure = lines.find(positiveClosure);
  const candidates = [];
  const structuredDate = preciseValidThrough(structured?.validThrough);
  if (structuredDate) candidates.push({ date: structuredDate, quote: `validThrough: ${structured.validThrough}`, locator: 'JobPosting.validThrough' });
  for (const line of lines) {
    if (!/(?:报名|申请|投递|招聘).{0,120}(?:截止|截至)|截止(?:日期|时间)/.test(line)) continue;
    const dates = [...line.matchAll(/20\d{2}[年/.\-]\d{1,2}[月/.\-]\d{1,2}日?/g)];
    for (const match of dates) { const date = deadlineFact(match[0]).date; if (date) candidates.push({ date, quote: line, locator }); }
  }
  const dates = [...new Set(candidates.map(item => item.date))];
  const conflictingDates = dates.length > 1;
  const date = dates.length === 1 ? dates[0] : null;
  const deadlineQuote = candidates[0]?.quote || '';
  const today = new Date(Date.parse(checkedAt) + 8 * 3600000).toISOString().slice(0, 10);
  if (date) add({ deadline: date }, deadlineQuote, candidates[0].locator);
  if (conflictingDates) result.verification.reason = '同一岗位公告出现多个矛盾截止日期，需人工核验，不采纳截止日期';
  else if (closure || date && date < today) result.verification = { status: 'closed', reason: closure ? '匹配岗位公告明确标注停止招聘或报名结束' : '公告明确报名截止日期已过', evidenceUrl: sourceUrl, excerpt: clean(closure || deadlineQuote).slice(0, 260), checkedAt };
  else if (date) result.verification = { status: 'open', reason: '公告明确截止日期尚未到；不保证尚有招聘名额', evidenceUrl: sourceUrl, excerpt: clean(deadlineQuote).slice(0, 260), checkedAt };
  else result.verification.reason = '公告可读取，但没有可靠证据确认当前仍在招；长期招聘保持待核实';
  result.status = Object.keys(result.facts).length || result.verification.status !== 'unknown' ? 'ok' : 'needs_review';
  return result;
}

module.exports = { fetchAnnouncement, analyzeAnnouncement, canonicalAnnouncementUrl, htmlText, identityFor, robotsAllowed, publicAddress, VERSION };
