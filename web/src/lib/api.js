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

async function request(path, options = {}) {
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
    throw new ApiError(message, response.status, data?.error || data);
  }
  return data?.data ?? data;
}

export const api = {
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
  },
  admin: {
    users: signal => request('/admin/users', { signal }),
    setRole: (id, role) => request(`/admin/users/${encodeURIComponent(id)}/role`, { method: 'PUT', body: { role } }),
    setPlan: (id, planId) => request(`/admin/users/${encodeURIComponent(id)}/plan`, { method: 'PUT', body: { planId } }),
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
