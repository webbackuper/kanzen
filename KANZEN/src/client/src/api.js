// Client HTTP : cookie de session (même origine) + en-tête anti-CSRF exigé par le serveur.
export class ApiError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

let onUnauthorized = () => {};
// Identifiant de la websocket temps réel de cet onglet : renvoyé par le serveur dans les événements,
// pour reconnaître l'écho de ses propres modifications.
let socketId = null;
export const setSocketId = (id) => { socketId = id ?? null; };
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

async function request(method, url, body, { raw } = {}) {
  const headers = { 'X-Requested-With': 'KanZen' };
  if (socketId && method !== 'GET') headers['X-Socket-Id'] = socketId;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`/api${url}`, { method, headers, body: payload, credentials: 'same-origin' });
  if (raw) return res;
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/auth/login')) onUnauthorized();
    throw new ApiError(res.status, data?.error ?? `Erreur ${res.status}`, data?.code);
  }
  return data;
}

export const api = {
  get: (u) => request('GET', u),
  post: (u, b = {}) => request('POST', u, b),
  patch: (u, b) => request('PATCH', u, b),
  put: (u, b) => request('PUT', u, b),
  del: (u) => request('DELETE', u),
  upload: (u, file) => { const f = new FormData(); f.append('file', file); return request('POST', u, f); },
};
