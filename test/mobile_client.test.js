'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function client(t, fetcher) {
  const previous = { fetch: global.fetch, window: global.window };
  global.fetch = fetcher; global.window = new EventTarget();
  t.after(() => { global.fetch = previous.fetch; if (previous.window) global.window = previous.window; else delete global.window; });
  const source = fs.readFileSync(path.join(__dirname, '../web/src/lib/api.js'), 'utf8').replace('const API_ROOT = __PRODUCT_API_BASE__;', "const API_ROOT = '/api/v1';");
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64') + '#test-' + Math.random());
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('wrong current password does not revoke the browser UI session; expired auth does', async t => {
  let code = 'INVALID_CREDENTIALS', events = 0;
  const api = await client(t, async () => json({ ok: false, error: '请重新输入', code }, 401));
  window.addEventListener(api.AUTH_REQUIRED_EVENT, () => events++);
  await assert.rejects(api.request('/me/password', { method: 'POST', body: {} }), error => error.status === 401 && error.code === code);
  assert.equal(events, 0);
  code = 'AUTH_REQUIRED';
  await assert.rejects(api.request('/me/profile'), error => error.code === code);
  assert.equal(events, 1);
});

test('a stale unauthorized response cannot invalidate a newly authenticated account', async t => {
  let release;
  const api = await client(t, url => url.endsWith('/auth/login') ? Promise.resolve(json({ user: { id: 'new' }, sessionToken: 'test-only-token' })) : new Promise(resolve => { release = resolve; }));
  let events = 0; window.addEventListener(api.AUTH_REQUIRED_EVENT, () => events++);
  const stale = api.request('/me/profile');
  await Promise.resolve();
  await api.api.auth.login({ email: 'fake@example.invalid', password: 'test' });
  release(json({ ok: false, error: 'Expired', code: 'AUTH_REQUIRED' }, 401));
  await assert.rejects(stale, error => error.name === 'AbortError');
  assert.equal(events, 0);
});

test('mobile PWA scopes its cache and never intercepts private APIs, mutations or other apps', async () => {
  const { mobilePwa } = await import('../web/mobile-design/mobile-pwa.mjs');
  const plugin = mobilePwa(), emitted = new Map();
  plugin.configResolved({ base: '/app/mobile/' });
  assert.ok(plugin.transformIndexHtml().some(tag => tag.attrs.href === '/app/mobile/manifest.webmanifest'));
  plugin.generateBundle.call({ emitFile: file => emitted.set(file.fileName, file.source) }, {}, { 'assets/app-123.js': {}, 'assets/app-123.css': {} });
  const manifest = JSON.parse(emitted.get('manifest.webmanifest'));
  assert.equal(manifest.start_url, './index.html#/discover'); assert.equal(manifest.scope, './');
  const handlers = {};
  vm.runInNewContext(emitted.get('sw.js'), {
    URL, Set, Promise,
    self: { registration: { scope: 'https://example.com/app/mobile/' }, addEventListener: (name, handler) => { handlers[name] = handler; } },
    caches: { match: async () => new Response('shell') }, fetch: async () => new Response('network'),
  });
  const check = (url, { method = 'GET', mode = 'cors' } = {}) => {
    let intercepted = false;
    handlers.fetch({ request: { url, method, mode }, respondWith: () => { intercepted = true; } });
    return intercepted;
  };
  assert.equal(check('https://example.com/api/v1/me/profile'), false);
  assert.equal(check('https://example.com/app/mobile/api/me/profile'), false);
  assert.equal(check('https://example.com/app/mobile/private.json'), false);
  assert.equal(check('https://example.com/app/mobile/assets/app-123.js', { method: 'POST' }), false);
  assert.equal(check('https://example.com/app/index.html', { mode: 'navigate' }), false);
  assert.equal(check('https://other.example/app/mobile/assets/app-123.js'), false);
  assert.equal(check('https://example.com/app/mobile/assets/app-123.js'), true);
  assert.equal(check('https://example.com/app/mobile/index.html', { mode: 'navigate' }), true);
});

test('desktop service worker excludes mobile client routes from its shell cache', () => {
  const handlers = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../web/public/sw.js'), 'utf8'), {
    URL, self: { registration: { scope: 'https://example.com/usertest/' }, location: { origin: 'https://example.com' }, addEventListener: (name, handler) => { handlers[name] = handler; } },
  });
  for (const suffix of ['mobile/index.html', 'mobile-design/index.html']) {
    let intercepted = false;
    handlers.fetch({ request: { url: 'https://example.com/usertest/' + suffix, method: 'GET', mode: 'navigate' }, respondWith: () => { intercepted = true; } });
    assert.equal(intercepted, false);
  }
});

// Exercise the actual provider callbacks without a DOM dependency. Only JSX/context
// rendering is removed; state/ref/effect semantics used by the auth controller stay intact.
function mobileAuthHarness(t, handlers) {
  const source = fs.readFileSync(path.join(__dirname, '../web/mobile-design/src/lib/runtime.jsx'), 'utf8');
  const provider = source.slice(0, source.indexOf('  const value = useMemo')).replace(/^import .*;\r?$/gm, '').replace('export function MobileProvider', 'function MobileProvider') + '\nreturn { login, register, logout, refreshUser }; }\nglobalThis.makeProvider = MobileProvider;';
  const states = [], effects = [], draftsCleared = [], transport = [];
  const win = new EventTarget(), doc = new EventTarget(); doc.visibilityState = 'visible';
  const context = { Promise, AbortController, Error, String, Object, navigator: { onLine: true }, window: win, document: doc,
    sessionStorage: { removeItem() {} }, setTimeout: () => 0, clearTimeout() {}, createContext: () => ({}),
    useState(initial) { const index = states.length; states.push(typeof initial === 'function' ? initial() : initial); return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next; }]; },
    useRef: current => ({ current }), useCallback: fn => fn, useEffect: effect => effects.push(effect),
    api: { auth: handlers }, AUTH_REQUIRED_EVENT: 'test:auth-required', clearPrepDrafts: id => draftsCleared.push(id),
    clearNativeSession: async () => { transport.push('clear'); },
  };
  vm.runInNewContext(provider, context);
  const actions = context.makeProvider({ children: null });
  const cleanups = effects.map(effect => effect());
  t.after(() => cleanups.reverse().forEach(cleanup => cleanup?.()));
  return { ...actions, states, draftsCleared, transport, expire: () => win.dispatchEvent(new Event('test:auth-required')), foreground: () => doc.dispatchEvent(new Event('visibilitychange')) };
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

test('mobile auth mutation aborts older checks; old 401 cannot cancel a valid login', async t => {
  const oldCheck = deferred(), login = deferred(); let oldSignal;
  const mobile = mobileAuthHarness(t, { me: signal => { oldSignal = signal; return oldCheck.promise; }, login: () => login.promise });
  const attempt = mobile.login({ email: 'new@example.invalid' });
  assert.equal(oldSignal.aborted, true);
  mobile.expire();
  oldCheck.reject(Object.assign(new Error('old expired session'), { status: 401 }));
  login.resolve({ user: { id: 'new', email: 'new@example.invalid' } });
  assert.equal((await attempt).id, 'new');
  assert.equal(mobile.states[0].id, 'new'); assert.equal(mobile.states[1], 'authenticated'); assert.equal(mobile.states[3], false);
});

test('foreground refresh cannot take the login or logout mutation version', async t => {
  let reads = 0; const login = deferred(), logout = deferred();
  const mobile = mobileAuthHarness(t, { me: async () => { reads++; return { user: { id: 'same', email: 'same@example.invalid' } }; }, login: () => login.promise, logout: () => logout.promise });
  await flush();
  const signingIn = mobile.login({ email: 'same@example.invalid' }); const baseline = reads;
  mobile.foreground(); await mobile.refreshUser(); assert.equal(reads, baseline); assert.equal(mobile.states[3], true);
  login.resolve({ user: { id: 'same', email: 'same@example.invalid' } }); await signingIn;
  const signingOut = mobile.logout(); mobile.foreground(); assert.equal(reads, baseline); assert.equal(mobile.states[3], true);
  logout.resolve({ loggedOut: true }); assert.equal(await signingOut, true);
  assert.equal(mobile.states[0], null); assert.equal(mobile.states[1], 'anonymous'); assert.equal(mobile.states[3], false);
  assert.deepEqual(mobile.draftsCleared, ['same']);
});

test('uncertain login is reconciled against /me; confirmed server login is accepted', async t => {
  let loggedIn = false;
  const mobile = mobileAuthHarness(t, { me: async () => ({ user: loggedIn ? { id: 'recovered', email: 'me@example.invalid' } : null }), login: async () => { loggedIn = true; throw Object.assign(new Error('response lost'), { code: 'NETWORK_UNAVAILABLE' }); } });
  await flush();
  assert.equal((await mobile.login({ email: 'me@example.invalid' })).id, 'recovered');
  assert.equal(mobile.states[1], 'authenticated'); assert.equal(mobile.states[3], false);
});

test('uncertain logout verifies expiry; failed verification blocks writing instead of claiming logout', async t => {
  let phase = 'initial';
  const mobile = mobileAuthHarness(t, { me: async () => { if (phase === 'offline') throw new Error('offline'); if (phase === 'expired') throw Object.assign(new Error('expired'), { status: 401 }); return { user: { id: 'member' } }; }, logout: async () => { throw new Error('response lost'); } });
  await flush(); phase = 'offline';
  await assert.rejects(mobile.logout(), /response lost/);
  assert.equal(mobile.states[1], 'error'); assert.equal(mobile.states[0].id, 'member'); assert.equal(mobile.states[3], false);
  phase = 'expired'; assert.equal(await mobile.logout(), true);
  assert.equal(mobile.states[1], 'anonymous'); assert.equal(mobile.states[0], null);
});

test('same-account passive checks preserve drafts; real expiry and account changes clear old drafts', async t => {
  let user = { id: 'first' }; const mobile = mobileAuthHarness(t, { me: async () => ({ user }) });
  await flush(); await mobile.refreshUser();
  assert.deepEqual(mobile.draftsCleared, []); assert.equal(mobile.states[3], false);
  user = { id: 'second' }; await mobile.refreshUser(); assert.deepEqual(mobile.draftsCleared, ['first']);
  mobile.expire(); assert.equal(mobile.states[0], null); assert.equal(mobile.states[1], 'anonymous');
  assert.deepEqual(mobile.draftsCleared, ['first', 'second']);
});

test('a second active auth mutation is rejected before sending another request', async t => {
  const login = deferred(); let logoutCalls = 0;
  const mobile = mobileAuthHarness(t, { me: async () => ({ user: null }), login: () => login.promise, logout: async () => { logoutCalls++; } });
  await flush(); const signingIn = mobile.login({ email: 'one@example.invalid' });
  await assert.rejects(mobile.logout(), /正在处理账号操作/); assert.equal(logoutCalls, 0);
  login.resolve({ user: { id: 'one', email: 'one@example.invalid' } }); await signingIn;
});
