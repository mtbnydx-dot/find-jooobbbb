const API_ROOT = __PRODUCT_API_BASE__;

export class ApiError extends Error {
  constructor(message, status = 0, details = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
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
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  let response;
  try {
    response = await fetch(`${API_ROOT}${path}`, {
      credentials: 'include',
      ...options,
      headers,
      body: options.body === undefined || options.body instanceof FormData
        ? options.body
        : JSON.stringify(options.body),
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new ApiError(navigator.onLine ? '暂时无法连接服务器，请稍后重试' : '当前处于离线状态', 0, error);
  }

  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json')
    ? await response.json().catch(() => ({}))
    : await response.text().catch(() => '');

  if (!response.ok || data?.ok === false) {
    const message = data?.error?.message || data?.error || data?.message || `请求失败（${response.status}）`;
    throw new ApiError(message, response.status, data?.error && typeof data.error === 'object' ? data.error : data);
  }
  return data?.data ?? data;
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
