'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeAnnouncement, fetchAnnouncement, canonicalAnnouncementUrl, robotsAllowed, publicAddress, htmlText } = require('../server/product/announcement-source');
const job = { id: 'one', company: '示例科技有限公司', position: '前端开发工程师', audience: '2027届' };
const base = { job, url: 'https://careers.example.com/job/one', checkedAt: '2026-10-23T00:00:00Z', accessStatus: 'ok' };
const html = body => `<html><title>示例科技有限公司前端开发工程师</title><body><h1>示例科技有限公司 前端开发工程师</h1>${body}</body></html>`;
const jsonld = value => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
const posting = { '@type': 'JobPosting', title: job.position, hiringOrganization: { name: job.company }, description: '<p>招聘2027届</p><p>专业要求：计算机相关专业</p>', baseSalary: { currency: 'CNY', value: { minValue: 18000, maxValue: 25000, unitText: 'MONTH' } } };

test('literal public labels preserve unknowns, preferences and salary evidence as one group', () => {
  const result = analyzeAnnouncement({ ...base, html: html('<p>专业要求：计算机相关专业</p><p>工作经验：1–3年，实习经历优先</p><p>薪资待遇：人民币18000-25000元/月，13薪</p><p>福利：五险一金</p>') });
  assert.equal(result.identity.level, 'exact'); assert.equal(result.status, 'ok');
  assert.equal(result.facts.major, '计算机相关专业'); assert.equal(result.facts.experience, '1–3年，实习经历优先');
  assert.equal(result.facts.salaryCurrency, 'CNY'); assert.equal(result.facts.salaryPeriod, 'month'); assert.equal(result.facts.salaryMonths, 13);
  assert.equal(result.verification.status, 'unknown'); assert(result.evidence.every(item => item.sourceUrl === base.url && item.quote));
  const unknown = analyzeAnnouncement({ ...base, html: html('<p>报名2027年，生活补贴50000元。长期招聘，招满即止。</p>') });
  assert.equal(unknown.facts.salaryText, undefined); assert.equal(unknown.verification.status, 'unknown');
  const annual = analyzeAnnouncement({ ...base, html: html('<p>年薪：20万元</p>') });
  assert.equal(annual.facts.salaryPeriod, 'year'); assert.equal(annual.facts.salaryText, '年薪：20万元');
});

test('structured salary is scoped to an exactly matching JobPosting, not neighbouring jobs', () => {
  const result = analyzeAnnouncement({ ...base, html: jsonld([posting, { ...posting, title: '财务经理', baseSalary: { currency: 'AUD', value: { value: 90000, unitText: 'YEAR' } } }]) });
  assert.equal(result.facts.salaryMin, 18000); assert.equal(result.facts.salaryCurrency, 'CNY'); assert.equal(result.facts.major, '计算机相关专业');
  assert.equal(result.evidence.find(item => item.fields.includes('salaryMin')).locator, 'JobPosting.baseSalary');
  assert.equal(analyzeAnnouncement({ ...base, html: jsonld([{ ...posting, title: '财务经理' }]) }).status, 'mismatch');
  assert.equal(analyzeAnnouncement({ ...base, html: jsonld([posting, posting]) }).status, 'mismatch');
});

test('same URL changed cohort, multi-role aggregates and mismatched companies cannot gain per-role facts', () => {
  const cohort = analyzeAnnouncement({ ...base, html: html('<p>本次招聘2026届。薪资：20000元/月</p>') });
  assert.equal(cohort.status, 'mismatch'); assert.deepEqual(cohort.facts, {});
  const multiple = analyzeAnnouncement({ ...base, job: { ...job, position: '前端开发工程师、财务经理' }, html: html('<p>财务经理</p><p>薪资：20000元/月</p>') });
  assert.equal(multiple.identity.level, 'ambiguous'); assert.deepEqual(multiple.facts, {});
  const wrong = analyzeAnnouncement({ ...base, job: { ...job, company: '其他单位' }, html: html('<p>薪资：20000元/月</p>') });
  assert.equal(wrong.status, 'mismatch'); assert.deepEqual(wrong.facts, {});
});

test('only a matching table row supplies qualifications, duplicate role names require review', () => {
  const table = '<table><tr><th>岗位</th><th>专业要求</th><th>工作经验</th></tr><tr><td>前端开发工程师</td><td>计算机</td><td>1年</td></tr><tr><td>财务经理</td><td>会计学</td><td>5年</td></tr></table>';
  const result = analyzeAnnouncement({ ...base, html: html(table) });
  assert.equal(result.facts.major, '计算机'); assert.equal(result.facts.experience, '1年');
  assert(!JSON.stringify(result.facts).includes('会计'));
  const ambiguous = analyzeAnnouncement({ ...base, html: html(table.replace('财务经理', '前端开发工程师')) });
  assert.equal(ambiguous.identity.level, 'ambiguous'); assert.deepEqual(ambiguous.facts, {});
});

test('only explicit closure or a precise deadline establishes status, errors and rolling text do not', () => {
  const closed = analyzeAnnouncement({ ...base, html: html('<p>该职位已关闭</p>') }); assert.equal(closed.verification.status, 'closed');
  const expired = analyzeAnnouncement({ ...base, html: html('<p>报名截止日期：2026年10月22日</p>') }); assert.equal(expired.verification.status, 'closed'); assert.equal(expired.facts.deadline, '2026-10-22');
  const open = analyzeAnnouncement({ ...base, html: jsonld({ ...posting, validThrough: '2026-10-24' }) }); assert.equal(open.verification.status, 'open');
  assert.equal(analyzeAnnouncement({ ...base, html: html('<p>自发布日起7个工作日内报名</p>') }).verification.status, 'unknown');
  for (const accessStatus of ['blocked', 'unsupported', 'unavailable']) {
    const inaccessible = analyzeAnnouncement({ ...base, accessStatus, html: html('<p>该职位已关闭</p>'), statusCode: 404 });
    assert.equal(inaccessible.verification.status, 'unknown'); assert.deepEqual(inaccessible.facts, {});
  }
});

test('URL normalization preserves job identifiers and SPA routes while removing only tracking', () => {
  assert.equal(canonicalAnnouncementUrl('https://x.example/job?id=1&utm_source=test'), 'https://x.example/job?id=1');
  assert.notEqual(canonicalAnnouncementUrl('https://x.example/#/job/1'), canonicalAnnouncementUrl('https://x.example/#/job/2'));
  assert.notEqual(canonicalAnnouncementUrl('https://x.example/job?ref=1&source=a'), canonicalAnnouncementUrl('https://x.example/job?ref=2&source=b'));
  for (const input of ['file:///etc/passwd', 'https://u:p@x.example/', 'http://x.example:3306/']) assert.equal(canonicalAnnouncementUrl(input), '');
  for (const ip of ['127.0.0.1', '10.0.0.1', '192.168.0.2', '169.254.169.254', '100.64.1.1', '::1', '::ffff:127.0.0.1', 'fd00::1']) assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress('93.184.216.34'), true);
});

test('robots restrictions respect longest matching allow and named agent groups', () => {
  assert.equal(robotsAllowed('User-agent: *\nDisallow: /private\nAllow: /private/jobs', 'https://x.example/private/jobs/1'), true);
  assert.equal(robotsAllowed('User-agent: *\nDisallow: /', 'https://x.example/job/1'), false);
  assert.equal(robotsAllowed('User-agent: *\nAllow: /\nUser-agent: ZhiluJobEvidence\nDisallow: /jobs', 'https://x.example/jobs/1'), false);
});

test('fetch uses public pinned destinations, bounded types, robots and explicit inaccessible states', async () => {
  const calls = [];
  const resolve = async () => [{ address: '93.184.216.34', family: 4 }];
  const requestImpl = async url => { calls.push(url.href); return url.pathname === '/robots.txt' ? { statusCode: 404, headers: {}, body: '' } : { statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: html('<p>公司岗位原公告。专业：计算机</p>') }; };
  const result = await fetchAnnouncement(base.url, { requestImpl, resolve });
  assert.equal(result.accessStatus, 'ok'); assert.equal(calls.length, 2); assert(result.contentHash); assert(result.text.includes('计算机'));
  const forbidden = await fetchAnnouncement(base.url, { resolve, requestImpl: async () => ({ statusCode: 200, headers: {}, body: 'User-agent: *\nDisallow: /' }) });
  assert.equal(forbidden.accessStatus, 'blocked');
  const missing = await fetchAnnouncement(base.url, { resolve, requestImpl: async () => ({ statusCode: 404, headers: {}, body: '' }) });
  assert.equal(missing.accessStatus, 'unavailable');
  const pdf = await fetchAnnouncement(base.url, { resolve, requestImpl: async url => url.pathname === '/robots.txt' ? { statusCode: 404, headers: {}, body: '' } : { statusCode: 200, headers: { 'content-type': 'application/pdf' }, body: 'PDF' } });
  assert.equal(pdf.accessStatus, 'unsupported');
  const privateRedirect = await fetchAnnouncement(base.url, { resolve, requestImpl: async url => url.pathname === '/robots.txt' ? { statusCode: 404, headers: {}, body: '' } : { statusCode: 302, headers: { location: 'http://127.0.0.1/admin' }, body: '' } });
  assert.equal(privateRedirect.accessStatus, 'unsupported'); assert.equal(privateRedirect.text, '');
  const redirectCalls = [];
  const external = await fetchAnnouncement(base.url, { resolve, requestImpl: async url => { redirectCalls.push(url.href); return url.pathname === '/robots.txt' ? { statusCode:404, headers:{}, body:'' } : { statusCode:302, headers:{ location:'https://second.example/jobs' }, body:'' }; } });
  assert.equal(external.accessStatus, 'unsupported'); assert.equal(redirectCalls.length, 2); assert(!redirectCalls.some(value => value.includes('second.example')));
  const blockedDns = await fetchAnnouncement(base.url, { resolve: async () => [{ address: '10.0.0.1', family: 4 }], requestImpl: async () => { throw new Error('must never request private IP'); } });
  assert.equal(blockedDns.accessStatus, 'unavailable');
});

test('HTML text extraction does not execute scripts and preserves literal table lines', () => {
  assert.equal(htmlText('<p>薪资&nbsp;：&yen;待定</p><script>throw 1</script><p>专业：计算机</p>').includes('throw'), false);
  assert(htmlText('<p>&#x8BA1;&#31639;&#x673A;</p>').includes('计算机'));
});

test('ordinary multi-role notices use only the unique matching heading or label section', () => {
  const page = '<h1>示例科技有限公司招聘</h1><h2>前端开发工程师</h2><p>负责系统开发</p><h2>财务经理</h2><p>专业要求：会计学</p><p>工作经验：五年</p><p>该岗位已招满</p>';
  const result = analyzeAnnouncement({ ...base, html: page });
  assert.equal(result.identity.level, 'exact'); assert.deepEqual(result.facts, {}); assert.equal(result.verification.status, 'unknown');
  const labelled = analyzeAnnouncement({ ...base, html: '<p>示例科技有限公司</p><p>岗位名称：前端开发工程师</p><p>专业要求：计算机</p><p>职位名称：财务经理</p><p>工作经验：五年</p><p>该岗位已关闭</p>' });
  assert.equal(labelled.facts.major, '计算机'); assert.equal(labelled.facts.experience, undefined); assert.equal(labelled.verification.status, 'unknown');
  const unbounded = analyzeAnnouncement({ ...base, html: html('<h2>财务经理</h2><p>专业要求：会计学</p>') });
  assert.equal(unbounded.identity.level, 'ambiguous'); assert.deepEqual(unbounded.facts, {});
  const duplicate = analyzeAnnouncement({ ...base, html: '<h1>示例科技有限公司招聘</h1><h2>前端开发工程师</h2><p>专业：计算机</p><h2>前端开发工程师</h2><p>专业：电子工程</p>' });
  assert.equal(duplicate.identity.level, 'ambiguous'); assert.deepEqual(duplicate.facts, {});
});

test('negative, hypothetical and neighbour closure messages never establish a closed position', () => {
  for (const phrase of ['该岗位尚未停止招聘', '该岗位没有停止招聘', '该岗位并不停止招聘', '如该岗位已招满，请关注其他职位。', '当该岗位已招满时，会另行通知', '如果该岗位已关闭，请刷新查看其他岗位', '部分岗位已招满，仍可查看其他机会', '并非该岗位已关闭', '历史岗位已关闭，请关注本年度招聘']) {
    const result = analyzeAnnouncement({ ...base, html: html(`<p>${phrase}</p>`) });
    assert.equal(result.verification.status, 'unknown', phrase);
  }
  assert.equal(analyzeAnnouncement({ ...base, html: html('<p>该岗位已招满，感谢关注。</p>') }).verification.status, 'closed');
});

test('structured validThrough requires a complete calendar-valid date, not permissive Date.parse input', () => {
  for (const value of ['2026', '2026-10', 'October 2026', '2026-02-30', '2026-10-24junk', '2026-10-24T25:00:00Z', '2026-10-24T09:00:00']) {
    const result = analyzeAnnouncement({ ...base, html: jsonld({ ...posting, validThrough: value }) });
    assert.equal(result.facts.deadline, undefined, value); assert.equal(result.verification.status, 'unknown', value);
  }
  const exact = analyzeAnnouncement({ ...base, html: jsonld({ ...posting, validThrough: '2026-10-24T01:00:00+14:00' }) });
  assert.equal(exact.facts.deadline, '2026-10-23'); assert.equal(exact.verification.status, 'open');
});

test('contradictory absolute deadlines remain unknown, including structured and prose conflicts', () => {
  for (const body of ['<p>报名截止：2026年10月22日</p><p>申请截止：2026年10月30日</p>', '<p>报名自2026年10月01日至2026年10月30日截止</p>']) {
    const result = analyzeAnnouncement({ ...base, html: html(body) });
    assert.equal(result.facts.deadline, undefined); assert.equal(result.verification.status, 'unknown'); assert.match(result.verification.reason, /多个矛盾/);
  }
  const structured = analyzeAnnouncement({ ...base, html: jsonld({ ...posting, validThrough: '2026-10-30', description: '<p>招聘2027届</p><p>报名截止：2026年10月22日</p>' }) });
  assert.equal(structured.facts.deadline, undefined); assert.equal(structured.verification.status, 'unknown');
  const consistent = analyzeAnnouncement({ ...base, html: html('<p>报名截止：2026年10月30日</p><p>投递截止：2026-10-30</p>') });
  assert.equal(consistent.facts.deadline, '2026-10-30'); assert.equal(consistent.verification.status, 'open');
});

test('a shared table does not transfer a same-named position from another company', () => {
  const result = analyzeAnnouncement({ ...base, html: '<h1>示例科技有限公司与其他单位招聘</h1><table><tr><th>公司名称</th><th>岗位</th><th>专业要求</th></tr><tr><td>其他单位</td><td>前端开发工程师</td><td>计算机</td></tr></table>' });
  assert.equal(result.status, 'mismatch'); assert.deepEqual(result.facts, {});
});
