const API_ROOT = __PRODUCT_API_BASE__;
export const AUTH_REQUIRED_EVENT = 'zhilu:auth-required';
let nativeTransport = null;
let sessionGeneration = 0;

// A native host may supply Keychain/Keystore-backed methods before mounting React.
// The website never persists session tokens in localStorage or JavaScript cookies.
export function configureNativeTransport(adapter = null) {
  if (adapter && (!/^https:\/\//.test(adapter.baseUrl || '') || typeof adapter.getToken !== 'function')) throw new Error('原生连接需 HTTPS API 地址及安全令牌读取方法');
  nativeTransport = adapter;
}

export async function clearNativeSession() { sessionGeneration += 1; await nativeTransport?.clearSession?.(); }
export function newRequestKey() { return globalThis.crypto?.randomUUID?.() || `req-${Date.now()}-${Math.random().toString(36).slice(2)}`; }

export class ApiError extends Error {
  constructor(message, status = 0, details = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
    this.code = details?.code || details?.error?.code || (status === 401 ? 'AUTH_REQUIRED' : '');
  }
}

function withQuery(path, params = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    if (Array.isArray(value)) value.forEach(item => query.append(key, item));
    else query.set(key, String(value));
  });
  const suffix = query.toString();
  return `${path}${suffix ? `?${suffix}` : ''}`;
}

export async function request(path, options = {}) {
  const requestGeneration = sessionGeneration;
  const { timeoutMs = 20000, signal, responseType, ...fetchOptions } = options;
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  try {
    const token = await nativeTransport?.getToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const response = await fetch(`${nativeTransport?.baseUrl?.replace(/\/$/, '') || API_ROOT}${path}`, {
      credentials: nativeTransport ? 'omit' : 'include',
      ...fetchOptions,
      signal: controller.signal,
      headers,
      body: options.body === undefined || options.body instanceof FormData
        ? options.body
        : JSON.stringify(options.body),
    });
  if (responseType === 'blob' && response.ok) return await response.blob();
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json')
    ? await response.json().catch(() => ({}))
    : await response.text().catch(() => '');
  if (controller.signal.aborted) { const error = new Error('Aborted'); error.name = 'AbortError'; throw error; }

  if (!response.ok || data?.ok === false) {
    if (response.status === 401 && requestGeneration !== sessionGeneration) { const error = new Error('登录凭据已更新，忽略旧请求'); error.name = 'AbortError'; throw error; }
    const message = data?.error?.message || data?.error || data?.message || `请求失败（${response.status}）`;
    // Re-entering the wrong current password is not an expired session.
    const rejectionCode = data?.code || data?.error?.code;
    if (response.status === 401 && rejectionCode !== 'INVALID_CREDENTIALS' && !['/auth/login', '/auth/register', '/auth/reset-password', '/auth/verify-email'].includes(path)) window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT));
    throw new ApiError(message, response.status, data?.error && typeof data.error === 'object' ? { ...data, ...data.error } : data);
  }
  if (path === '/auth/me' && requestGeneration !== sessionGeneration) { const error = new Error('登录状态已变化，忽略旧响应'); error.name = 'AbortError'; throw error; }
  if (data?.sessionToken) {
    sessionGeneration += 1;
    if (nativeTransport) await nativeTransport.saveSession?.({ token: data.sessionToken, expiresAt: data.expiresAt });
  }
  return data?.data ?? data;
  } catch (error) {
    if (timedOut) throw new ApiError('连接超时。操作可能已到达服务器，请按页面提示重试，不要重复创建。', 0, { code: 'REQUEST_TIMEOUT' });
    if (error instanceof ApiError || error?.name === 'AbortError') throw error;
    throw new ApiError(navigator.onLine ? '暂时无法连接服务器，请稍后重试' : '当前处于离线状态', 0, { code: 'NETWORK_UNAVAILABLE' });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

export const api = {
  account: {
    export: () => request('/me/export'),
    delete: body => request('/me/account',{method:'DELETE',body}),
  },
  notifications: {
    list: signal => request('/me/notifications', { signal }),
    read: () => request('/me/notifications/read', { method: 'POST', body: {} }),
  },
  auth: {
    capabilities: signal => request('/auth/capabilities', { signal }),
    renew: () => request('/auth/refresh', { method: 'POST', body: {} }),
    forgot: email => request('/auth/forgot-password', { method: 'POST', body: { email } }),
    reset: body => request('/auth/reset-password', { method: 'POST', body }),
    sendVerification: () => request('/me/email-verification', { method: 'POST', body: {} }),
    verify: token => request('/auth/verify-email', { method: 'POST', body: { token } }),
    me: signal => request('/auth/me', { signal }),
    login: credentials => request('/auth/login', { method: 'POST', body: credentials }),
    register: account => request('/auth/register', { method: 'POST', body: account }),
    logout: () => request('/auth/logout', { method: 'POST', body: {} }),
  },
  dashboard: {
    get: signal => request('/dashboard', { signal }),
  },
  jobs: {
    list: (params, signal) => request(withQuery('/jobs', params), { signal }),
    get: (id, signal) => request(`/jobs/${encodeURIComponent(id)}`, { signal }),
    updateState: (id, state) => request(`/me/jobs/${encodeURIComponent(id)}`, { method: 'PUT', body: state }),
  },
  profile: {
    get: signal => request('/me/profile', { signal }),
    update: profile => request('/me/profile', { method: 'PUT', body: profile }),
  },
  pipeline: {
    get: signal => request('/me/pipeline', { signal }),
  },
  prep: {
    library: signal => request('/prep/library', { signal }),
    tracks: signal => request('/prep/tracks', { signal }),
    questions: (params, signal) => request(withQuery('/prep/questions', params), { signal }),
    submit: attempt => request('/prep/attempts', { method: 'POST', body: attempt }),
  },
  exams: {
    packs: (params, signal) => request(withQuery('/exams/packs', params), { signal }),
    pack: (id, signal) => request(`/exams/packs/${encodeURIComponent(id)}`, { signal }),
    start: packId => request('/exams/sessions', { method: 'POST', body: { packId } }),
    session: (id, signal) => request(`/exams/sessions/${encodeURIComponent(id)}`, { signal }),
    save: (id, progress) => request(`/exams/sessions/${encodeURIComponent(id)}`, { method: 'PUT', body: progress }),
    submit: (id, progress) => request(`/exams/sessions/${encodeURIComponent(id)}/submit`, { method: 'POST', body: progress }),
    summary: signal => request('/me/exams/summary', { signal }),
    wrong: (params, signal) => request(withQuery('/me/exams/wrong', params), { signal }),
    forJob: (jobId, signal) => request(`/jobs/${encodeURIComponent(jobId)}/exam-packs`, { signal }),
  },
  salary: {
    insights: signal => request('/salary/insights', { signal }),
  },
  billing: {
    plans: signal => request('/plans', { signal }),
    entitlements: signal => request('/me/entitlements', { signal }),
    checkout: planId => request('/billing/checkout', { method: 'POST', body: { planId } }),
    orders: (signal, params) => request(withQuery('/me/orders', params), { signal }),
    request: body => request('/me/orders', { method: 'POST', body }),
    cancel: id => request(`/me/orders/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {} }),
  },
  support: {
    list: (signal, params) => request(withQuery('/me/tickets', params), { signal }),
    create: body => request('/me/tickets', { method: 'POST', body }),
    reply: (id, message) => request(`/me/tickets/${encodeURIComponent(id)}/replies`, { method: 'POST', body: { message } }),
  },
  admin: {
    users: (signal, params) => request(withQuery('/admin/users', params), { signal }),
    setRole: (id, role) => request(`/admin/users/${encodeURIComponent(id)}/role`, { method: 'PUT', body: { role } }),
    setPlan: (id, planId, options = {}) => request(`/admin/users/${encodeURIComponent(id)}/plan`, { method: 'PUT', body: { planId, ...options } }),
    setStatus: (id, status, reason) => request(`/admin/users/${encodeURIComponent(id)}/status`, { method: 'PUT', body: { status, reason } }),
    revokeSessions: (id, reason) => request(`/admin/users/${encodeURIComponent(id)}/sessions`, { method: 'DELETE', body: { reason } }),
    overview: signal => request('/admin/overview', { signal }),
    orders: (signal, params) => request(withQuery('/admin/orders', params), { signal }),
    reviewOrder: (id, body) => request(`/admin/orders/${encodeURIComponent(id)}`, { method: 'PUT', body }),
    plans: signal => request('/admin/plans', { signal }),
    updatePlan: (id, body) => request(`/admin/plans/${encodeURIComponent(id)}`, { method: 'PUT', body }),
    tickets: (signal, params) => request(withQuery('/admin/tickets', params), { signal }),
    updateTicket: (id, body) => request(`/admin/tickets/${encodeURIComponent(id)}`, { method: 'PUT', body }),
    audit: (signal, params) => request(withQuery('/admin/audit', params), { signal }),
  },
};

export function listPayload(data, preferredKey) {
  if (Array.isArray(data)) return { items: data, nextCursor: '', total: data.length };
  const items = data?.[preferredKey] || data?.items || data?.results || data?.jobs || [];
  return {
    items: Array.isArray(items) ? items : [],
    nextCursor: data?.nextCursor || data?.next_cursor || data?.pagination?.nextCursor || '',
    total: Number(data?.total ?? data?.pagination?.total ?? items?.length ?? 0),
  };
}
