'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const test = require('node:test');
const express = require('../server/node_modules/express');
const { ProductPlatform, createProductRouter } = require('../server/product');

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'job-commerce-'));
  let now = Date.parse('2026-10-22T08:00:00.000Z');
  const platform = new ProductPlatform({ dataDir: directory, clock: () => now, jobService: { snapshot: () => ({ jobs: [{ id: 'job_1', active: '1', company: '示例公司', position: '市场分析', location: '上海' }] }) } }).initialize();
  const app = express(); app.use('/api/v1', createProductRouter({ platform }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const call = async (url, user, method = 'GET', body) => {
    const response = await fetch(base + url, { method, headers: { ...(user ? { Authorization: `Bearer ${user.token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, ...await response.json() };
  };
  const account = async (email, role = 'user') => {
    const result = await platform.register({ email, password: 'Testing-password-123', displayName: email.split('@')[0] });
    if (role !== 'user') platform.store.setUserRole(result.user.id, role);
    return { ...result, user: platform.store.getUser(result.user.id) };
  };
  const admin = await account('admin@example.com', 'admin');
  const first = await account('one@example.com');
  const second = await account('two@example.com');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); platform.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { platform, call, admin, first, second, account, setTime: value => { now = value; } };
}

test('published membership terms use cents, no auto-renew and do not expose unsupported human coaching', async t => {
  const f = await fixture(t);
  const result = await f.call('/plans');
  assert.equal(result.status, 200);
  assert.equal(result.purchaseMode, 'manual_review');
  assert.equal(result.paymentConfigured, false);
  assert.equal(result.autoRenew, false);
  assert.equal(result.plans.find(p => p.id === 'free').aiDailyLimit, 20);
  assert.equal(result.plans.find(p => p.id === 'pro').aiDailyLimit, 500);
  require('../server/product/personal-ai').initializePersonalAi(f.platform).updateSettings(f.admin.user, { limits: { pro: 450 } });
  assert.equal((await f.call('/plans')).plans.find(p => p.id === 'pro').aiDailyLimit, 450);
  assert.deepEqual(result.plans.find(p => p.id === 'pro').terms.map(term => [term.days, term.price]), [[30, 3900], [90, 9900], [365, 29900]]);
  const sprint = result.plans.find(p => p.id === 'coach');
  assert.equal(sprint.name, '冲刺版');
  assert.equal(sprint.entitlements['coach.feedback'], 0);
  assert.equal(sprint.entitlements['savedSearches.limit'], 100);
  assert.equal((await f.call('/billing/checkout', f.first, 'POST', { planId: 'pro' })).status, 503);
});

test('legacy plans and locked snapshots gain only the three workspace defaults without rewriting historical rows', async t => {
  const f = await fixture(t); const db = f.platform.store.db;
  const defaults = { free: [3, 3, 2], pro: [20, 20, 10], coach: [100, 100, 50] };
  const keys = ['savedSearches.limit', 'offers.limit', 'studyPlans.limit'];
  for (const planId of Object.keys(defaults)) {
    const old = { 'prep.attempts.daily': planId === 'coach' ? 500 : 17, 'profile.majors': 3, 'prep.tracks': -1, 'legacy.custom': 42 };
    db.prepare('UPDATE plans SET entitlements_json=? WHERE id=?').run(JSON.stringify(old), planId);
  }
  db.prepare("UPDATE subscriptions SET plan_id='pro',entitlements_snapshot_json=? WHERE user_id=?")
    .run(JSON.stringify({ 'prep.attempts.daily': 37, 'profile.majors': 2, 'legacy.locked': 91 }), f.first.user.id);
  db.prepare("UPDATE subscriptions SET plan_id='coach',entitlements_snapshot_json=? WHERE user_id=?")
    .run(JSON.stringify({ 'prep.attempts.daily': 500, 'profile.majors': 3 }), f.second.user.id);
  const persisted = () => Object.fromEntries(['plans', 'subscriptions', 'profiles'].map(table => [table, JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())]));
  const before = persisted();
  for (const [planId, expected] of Object.entries(defaults)) {
    const plan = f.platform.store.getPlan(planId);
    assert.deepEqual(keys.map(key => plan.entitlements[key]), expected);
    assert.equal(plan.entitlements['legacy.custom'], 42);
    assert.equal(Object.hasOwn(plan.entitlements, 'salary.insights'), false); // No broad seed merge.
  }
  const active = f.platform.store.getUserPlan(f.first.user.id);
  assert.deepEqual(keys.map(key => active.entitlements[key]), defaults.pro);
  assert.equal(active.entitlements['prep.attempts.daily'], 37); assert.equal(active.entitlements['legacy.locked'], 91);
  assert.equal(Object.hasOwn(active.entitlements, 'legacy.custom'), false); // Snapshot does not inherit other current-plan fields.
  assert.equal(active.subscription.entitlementsLocked, true);
  assert.equal(f.platform.store.getUserPlan(f.second.user.id).entitlements['prep.attempts.daily'], 500);
  const publicPlans = await f.call('/plans'); assert.equal(publicPlans.status, 200);
  assert.ok(publicPlans.plans.every(plan => !plan.features.join(' ').includes('undefined')));
  const allowance = await f.call('/me/entitlements', f.first);
  assert.deepEqual(keys.map(key => allowance.values[key].limit), defaults.pro);
  // More than the old Free fallback must work for a historical locked Pro plan,
  // and the actual restored limit must still be enforced.
  for (let i = 0; i < 20; i++) assert.equal((await f.call('/me/saved-searches', f.first, 'POST', { name: `历史权益 ${i}`, filters: { q: `不同搜索 ${i}` } })).status, 201);
  const full = await f.call('/me/saved-searches', f.first, 'POST', { name: '超出额度', filters: { q: '第21个不同搜索' } });
  assert.equal(full.status, 403); assert.equal(full.code, 'ENTITLEMENT_LIMIT');
  assert.deepEqual(persisted(), before);
});

test('workspace compatibility preserves explicit zero and unlimited values in plans and subscription snapshots', async t => {
  const f = await fixture(t); const db = f.platform.store.db;
  const values = { 'savedSearches.limit': 0, 'offers.limit': -1, 'studyPlans.limit': 0, 'prep.attempts.daily': 500 };
  db.prepare("UPDATE plans SET entitlements_json=? WHERE id='coach'").run(JSON.stringify(values));
  db.prepare("UPDATE subscriptions SET plan_id='coach',entitlements_snapshot_json=? WHERE user_id=?").run(JSON.stringify(values), f.first.user.id);
  const planBefore = db.prepare("SELECT entitlements_json FROM plans WHERE id='coach'").get().entitlements_json;
  const subscriptionBefore = JSON.stringify(db.prepare('SELECT * FROM subscriptions WHERE user_id=?').get(f.first.user.id));
  assert.deepEqual(f.platform.store.getPlan('coach').entitlements, values);
  assert.deepEqual(f.platform.store.getUserPlan(f.first.user.id).entitlements, values);
  const allowance = await f.call('/me/entitlements', f.first);
  assert.equal(allowance.values['offers.limit'].remaining, -1);
  assert.equal(allowance.values['savedSearches.limit'].limit, 0);
  assert.equal((await f.call('/me/saved-searches', f.first, 'POST', { name: '禁止创建', filters: {} })).status, 403);
  assert.equal((await f.call('/me/study-plans', f.first, 'POST', { title: '禁止创建', tasks: [{ title: '准备面试' }] })).status, 403);
  for (let i = 0; i < 4; i++) assert.equal((await f.call('/me/offers', f.first, 'POST', { company: `无限权益 ${i}`, position: '软件工程师' })).status, 201);
  assert.equal(db.prepare("SELECT entitlements_json FROM plans WHERE id='coach'").get().entitlements_json, planBefore);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM subscriptions WHERE user_id=?').get(f.first.user.id)), subscriptionBefore);
});

test('membership requests snapshot server prices, are idempotent, cancelable and private', async t => {
  const f = await fixture(t);
  const created = await f.call('/me/orders', f.first, 'POST', { planId: 'pro', termId: 'quarter', amount: 1, status: 'approved', idempotencyKey: 'request-a' });
  assert.equal(created.status, 201);
  assert.equal(created.order.amount, 9900);
  assert.equal(created.order.entitlementsSnapshot['prep.attempts.daily'], 100);
  assert.equal(created.order.status, 'pending');
  const repeated = await f.call('/me/orders', f.first, 'POST', { planId: 'pro', termId: 'quarter', idempotencyKey: 'request-a' });
  assert.equal(repeated.order.id, created.order.id);
  const otherBody = await f.call('/me/orders', f.first, 'POST', { planId: 'coach', termId: 'month', idempotencyKey: 'request-a' });
  assert.equal(otherBody.status, 409);
  assert.equal((await f.call('/me/orders', f.first, 'POST', { planId: 'coach', termId: 'month' })).status, 409);
  assert.deepEqual((await f.call('/me/orders', f.second)).orders, []);
  assert.equal((await f.call(`/me/orders/${created.order.id}/cancel`, f.second, 'POST', {})).status, 404);
  assert.equal((await f.call(`/me/orders/${created.order.id}/cancel`, f.first, 'POST', {})).order.status, 'cancelled');
  assert.equal((await f.call(`/admin/orders/${created.order.id}`, f.admin, 'PUT', { action: 'approve', reference: 'R-001', reason: '已核验' })).status, 409);
  assert.equal(f.platform.store.getUserPlan(f.first.user.id).id, 'free');
});

test('manual verification is atomic, extends expiry once, deduplicates reference and expires to free', async t => {
  const f = await fixture(t);
  const created = await f.call('/me/orders', f.first, 'POST', { planId: 'pro', termId: 'month' });
  const path = `/admin/orders/${created.order.id}`;
  assert.equal((await f.call(path, f.first, 'PUT', { action: 'approve', reference: 'R-001', reason: '自开通' })).status, 403);
  assert.equal((await f.call(path, f.admin, 'PUT', { action: 'approve', reason: '未核验' })).status, 400);
  const input = { action: 'approve', reference: 'R-001', reason: '核对收款记录，金额一致' };
  const [first, repeated] = await Promise.all([f.call(path, f.admin, 'PUT', input), f.call(path, f.admin, 'PUT', input)]);
  assert.equal(first.status, 200);
  assert.equal(repeated.order.currentPeriodEnd, first.order.currentPeriodEnd);
  assert.equal(first.order.currentPeriodEnd, '2026-11-21T08:00:00.000Z');
  assert.equal(f.platform.store.getUserPlan(f.first.user.id).id, 'pro');
  const renewal = await f.call('/me/orders', f.first, 'POST', { planId: 'pro', termId: 'quarter' });
  assert.equal((await f.call(`/admin/orders/${renewal.order.id}`, f.admin, 'PUT', { ...input, reference: 'r-001' })).status, 409);
  const renewed = await f.call(`/admin/orders/${renewal.order.id}`, f.admin, 'PUT', { ...input, reference: 'R-002' });
  assert.equal(renewed.order.currentPeriodEnd, '2027-02-19T08:00:00.000Z');
  assert.equal((await f.call(`/me/orders/${renewal.order.id}/cancel`, f.first, 'POST', {})).status, 409);
  const overview = await f.call('/admin/overview', f.admin);
  assert.equal(overview.overview.verifiedRevenue, 13800);
  assert.equal(overview.overview.approvedOrders, 2);
  assert.equal(overview.overview.paidMembers, 1);
  assert.equal((await f.call('/me/notifications', f.first)).items.length, 2);
  f.setTime(Date.parse('2027-02-20T00:00:00.000Z'));
  assert.equal(f.platform.store.getUserPlan(f.first.user.id).id, 'free');
  assert.equal(f.platform.store.getUserPlan(f.first.user.id).subscription.status, 'expired');
});

test('plan administration persists across restart and never reprices already submitted requests', async t => {
  const f = await fixture(t);
  const created = await f.call('/me/orders', f.first, 'POST', { planId: 'pro', termId: 'month' });
  assert.equal((await f.call('/admin/plans/pro', f.first, 'PUT', { name: 'tamper' })).status, 403);
  assert.equal((await f.call('/admin/plans/pro', f.admin, 'PUT', { entitlements: { 'coach.feedback': 1 } })).status, 400);
  assert.equal((await f.call('/admin/plans/pro', f.admin, 'PUT', { terms: [{ id: 'month', days: 300, price: 2500 }], entitlements: { 'prep.attempts.daily': 25 }, name: '测试专业版' })).status, 200);
  f.platform.store.close(); f.platform.store.initialize();
  const plan = f.platform.store.getPlan('pro');
  assert.equal(plan.name, '测试专业版');
  assert.equal(plan.priceMonthly, 2500);
  assert.equal(plan.terms[0].days, 30);
  assert.equal(plan.entitlements['prep.attempts.daily'], 25);
  // New router picks up reopened connection, as the production process would.
  const order = f.platform.store.db.prepare('SELECT * FROM membership_orders WHERE id=?').get(created.order.id);
  assert.equal(order.amount, 3900);
  assert.equal(JSON.parse(order.entitlements_json)['prep.attempts.daily'], 100);
});

test('admin lists paginate through all records and user history keeps its ownership filter', async t => {
  const f = await fixture(t);
  const firstPage = await f.call('/admin/users?limit=2', f.admin);
  assert.equal(firstPage.total, 3);
  assert.equal(firstPage.users.length, 2);
  assert.equal(firstPage.nextCursor, '2');
  const secondPage = await f.call(`/admin/users?limit=2&cursor=${firstPage.nextCursor}`, f.admin);
  assert.equal(secondPage.users.length, 1);
  assert.equal(secondPage.nextCursor, '');
  assert.equal(new Set([...firstPage.users, ...secondPage.users].map(user => user.id)).size, 3);
  assert.equal((await f.call('/admin/users?cursor=oops', f.admin)).status, 400);
  const filtered = await f.call('/admin/users?q=one', f.admin);
  assert.equal(filtered.total, 1);
  assert.equal(filtered.users[0].id, f.first.user.id);
  for (let n = 0; n < 3; n++) {
    const result = await f.call('/me/orders', f.first, 'POST', { planId: 'pro', termId: 'month' });
    await f.call(`/me/orders/${result.order.id}/cancel`, f.first, 'POST', {});
  }
  const orders = await f.call('/me/orders?limit=2', f.first);
  assert.equal(orders.total, 3);
  assert.equal(orders.nextCursor, '2');
  assert.equal((await f.call('/me/orders?limit=2&cursor=2', f.first)).orders.length, 1);
  assert.equal((await f.call('/me/orders?cursor=2', f.second)).total, 0);
});

test('verified membership locks submitted benefits across plan edits and renewals; tiers are not inferred from price', async t => {
  const f = await fixture(t);
  const submitted = await f.call('/me/orders', f.first, 'POST', { planId: 'pro', termId: 'month' });
  const changed = await f.call('/admin/plans/pro', f.admin, 'PUT', { entitlements: { 'prep.attempts.daily': 25, 'savedSearches.limit': 5 } });
  assert.equal(changed.status, 200);
  assert.equal((await f.call('/admin/plans/pro', f.admin, 'PUT', { entitlements: { 'profile.majors': 100 } })).status, 400);
  const verify = (orderId, reference) => f.call(`/admin/orders/${orderId}`, f.admin, 'PUT', { action: 'approve', reference, reason: '核验收款及申请快照' });
  assert.equal((await verify(submitted.order.id, 'LOCK-001')).status, 200);
  let active = f.platform.store.getUserPlan(f.first.user.id);
  assert.equal(active.entitlements['prep.attempts.daily'], 100);
  assert.equal(active.entitlements['savedSearches.limit'], 20);
  assert.equal(active.subscription.entitlementsLocked, true);
  const renewed = await f.call('/me/orders', f.first, 'POST', { planId: 'pro', termId: 'month' });
  assert.equal(renewed.order.entitlementsSnapshot['prep.attempts.daily'], 25);
  assert.equal((await verify(renewed.order.id, 'LOCK-002')).status, 200);
  active = f.platform.store.getUserPlan(f.first.user.id);
  assert.equal(active.entitlements['prep.attempts.daily'], 100);
  assert.equal(active.subscription.currentPeriodEnd, '2026-12-21T08:00:00.000Z');
  await f.call('/admin/plans/coach', f.admin, 'PUT', { terms: [{ id: 'month', price: 100 }] });
  await f.call(`/admin/users/${f.second.user.id}/plan`, f.admin, 'PUT', { planId: 'coach', days: 7, reason: '测试折扣不改变等级' });
  assert.equal((await f.call('/me/orders', f.second, 'POST', { planId: 'pro', termId: 'month' })).status, 409);
});

test('admin access guards, finite grants, audit records and account suspension revoke prior sessions', async t => {
  const f = await fixture(t);
  for (const endpoint of ['/admin/orders', '/admin/plans', '/admin/tickets', '/admin/audit', '/admin/overview']) {
    assert.equal((await f.call(endpoint)).status, 401);
    assert.equal((await f.call(endpoint, f.first)).status, 403);
  }
  assert.equal((await f.call(`/admin/users/${f.admin.user.id}/role`, f.admin, 'PUT', { role: 'user' })).status, 409);
  assert.equal((await f.call(`/admin/users/${f.first.user.id}/plan`, f.admin, 'PUT', { planId: 'pro', days: 999 })).status, 400);
  const granted = await f.call(`/admin/users/${f.first.user.id}/plan`, f.admin, 'PUT', { planId: 'pro', days: 7, reason: '受邀测试' });
  assert.equal(granted.plan.subscription.currentPeriodEnd, '2026-10-29T08:00:00.000Z');
  const suspended = await f.call(`/admin/users/${f.first.user.id}/status`, f.admin, 'PUT', { status: 'suspended', reason: '账户验证中' });
  assert.equal(suspended.user.status, 'suspended');
  assert.equal((await f.call('/auth/me', f.first)).status, 401);
  assert.equal((await f.call(`/admin/users/${f.first.user.id}/status`, f.admin, 'PUT', { status: 'active', reason: '验证完成' })).status, 200);
  assert.equal((await f.call('/auth/me', f.first)).status, 401);
  const audit = await f.call('/admin/audit', f.admin);
  assert.ok(audit.items.some(item => item.action === 'membership.granted' && item.detail.days === 7));
  assert.equal(audit.items.filter(item => item.action === 'user.status_changed').length, 2);
});

test('job correction and support conversations stay private, resolve with a reply and notify their owner', async t => {
  const f = await fixture(t);
  const created = await f.call('/me/tickets', f.first, 'POST', { category: 'job_correction', subject: '岗位截止日期有误', message: '原公告为下周截止', jobId: 'job_1' });
  assert.equal(created.status, 201);
  assert.equal(created.ticket.messages[0].authorRole, 'user');
  assert.deepEqual((await f.call('/me/tickets', f.second)).tickets, []);
  assert.equal((await f.call(`/me/tickets/${created.ticket.id}/replies`, f.second, 'POST', { message: '偷窥' })).status, 404);
  const editor = await f.account('editor@example.com', 'content_editor');
  assert.equal((await f.call('/admin/tickets', editor)).status, 403);
  assert.equal((await f.call(`/admin/tickets/${created.ticket.id}`, f.admin, 'PUT', { status: 'resolved' })).status, 400);
  const resolved = await f.call(`/admin/tickets/${created.ticket.id}`, f.admin, 'PUT', { status: 'resolved', message: '已核对原公告，感谢反馈。' });
  assert.equal(resolved.ticket.status, 'resolved');
  assert.equal(resolved.ticket.messages[1].authorRole, 'admin');
  assert.equal((await f.call('/me/notifications', f.first)).items.length, 1);
  assert.equal((await f.call('/me/notifications', f.second)).items.length, 0);
  const reopened = await f.call(`/me/tickets/${created.ticket.id}/replies`, f.first, 'POST', { message: '补充链接' });
  assert.equal(reopened.ticket.status, 'open');
  assert.equal(reopened.ticket.messages.length, 3);
});
