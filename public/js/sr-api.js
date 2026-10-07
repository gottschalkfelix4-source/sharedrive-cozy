/**
 * sharedrive - API-Zugriff aus dem Browser.
 * Setzt automatisch die Besucher-ID (nur gehasht serverseitig) fuer die
 * Download-Zaehlung und uebersetzt Fehler in lesbare Meldungen.
 */

const VISITOR_KEY = 'sharedrive.visitor';

export class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data || {};
  }
}

function visitorId() {
  try {
    let id = localStorage.getItem(VISITOR_KEY);
    if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
      id = crypto.randomUUID().replace(/-/g, '');
      localStorage.setItem(VISITOR_KEY, id);
    }
    return id;
  } catch {
    return null;
  }
}

async function request(method, path, { json, body, headers = {}, signal } = {}) {
  const init = { method, headers: { ...headers }, credentials: 'same-origin', signal };
  const vid = visitorId();
  if (vid) init.headers['X-Visitor-ID'] = vid;

  if (json !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(json);
  } else if (body !== undefined) {
    init.body = body;
  }

  const res = await fetch(path, init);
  const contentType = res.headers.get('content-type') || '';
  let data = null;
  if (contentType.includes('application/json')) {
    data = await res.json().catch(() => null);
  }
  if (!res.ok) {
    const message =
      (data && (data.error || data.message)) || `Fehler ${res.status} (${res.statusText || 'unbekannt'})`;
    throw new ApiError(res.status, message, data);
  }
  return data;
}

export const api = {
  config: () => request('GET', '/api/config'),

  createTransfer: (payload) => request('POST', '/api/transfers', { json: payload }),
  transferStatus: (id, token, signal) =>
    request('GET', `/api/transfers/${id}/status?t=${encodeURIComponent(token)}`, { signal }),
  completeTransfer: (id, token) =>
    request('POST', `/api/transfers/${id}/complete?t=${encodeURIComponent(token)}`),
  abortTransfer: (id, token) =>
    request('DELETE', `/api/transfers/${id}?t=${encodeURIComponent(token)}`),

  transferInfo: (id, signal) => request('GET', `/api/transfers/${id}`, { signal }),
  claimDownload: (id) => request('POST', `/api/transfers/${id}/claim`),

  uploadChunk: (id, token, fileIdx, chunkIdx, bytes, signal) =>
    request(
      'PUT',
      `/api/transfers/${id}/chunks/${fileIdx}/${chunkIdx}?t=${encodeURIComponent(token)}`,
      {
        body: bytes,
        headers: { 'Content-Type': 'application/octet-stream' },
        signal,
      }
    ),

  chunkUrl: (id, fileIdx, chunkIdx) => `/api/transfers/${id}/files/${fileIdx}/chunks/${chunkIdx}`,
  fetchChunk: (id, fileIdx, chunkIdx, signal) =>
    fetch(`/api/transfers/${id}/files/${fileIdx}/chunks/${chunkIdx}`, {
      credentials: 'same-origin',
      signal,
    }),

  requestInfo: (id, signal) => request('GET', `/api/requests/${id}`, { signal }),
  verifyRequestPassword: (id, password) =>
    request('POST', `/api/requests/${id}/verify`, { json: { password } }),

  admin: {
    login: (password) => request('POST', '/api/admin/login', { json: { password } }),
    logout: () => request('POST', '/api/admin/logout'),
    overview: () => request('GET', '/api/admin/overview'),
    transfers: (page = 1, q = '') =>
      request('GET', `/api/admin/transfers?page=${page}&q=${encodeURIComponent(q)}`),
    updateTransfer: (id, patch) => request('PATCH', `/api/admin/transfers/${id}`, { json: patch }),
    deleteTransfer: (id) => request('DELETE', `/api/admin/transfers/${id}`),
    transferDownloads: (id) => request('GET', `/api/admin/transfers/${id}/downloads`),
    activity: (limit = 50) => request('GET', `/api/admin/activity?limit=${limit}`),
    chart: (days = 14) => request('GET', `/api/admin/chart?days=${days}`),
    requests: (page = 1) => request('GET', `/api/admin/requests?page=${page}`),
    createRequest: (payload) => request('POST', '/api/admin/requests', { json: payload }),
    deleteRequest: (id) => request('DELETE', `/api/admin/requests/${id}`),
    requestSubmissions: (id) => request('GET', `/api/admin/requests/${id}/submissions`),
    updateBranding: (payload) => request('PATCH', '/api/admin/branding', { json: payload }),
    cleanup: () => request('POST', '/api/admin/maintenance/cleanup'),
    notifyTest: () => request('POST', '/api/admin/notify-test'),
  },
};

export default api;
