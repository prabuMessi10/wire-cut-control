// Thin fetch wrapper around the backend REST API.
//
// Base URL: VITE_API_URL if provided (cross-origin), otherwise the Vite dev
// server proxy handles /api -> http://localhost:5000 so requests stay
// same-origin and the httpOnly auth cookie just works.

const BASE = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');

/**
 * Fired on the window when the API returns 401 (e.g. an expired or revoked
 * JWT mid-session). AuthProvider listens and clears the user straight away so
 * protected routes redirect to /login instead of failing silently.
 */
export const UNAUTHORIZED_EVENT = 'wc:unauthorized';

function notifyUnauthorized() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
  }
}

async function request(path, { method = 'GET', body, headers = {}, signal } = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    credentials: 'include', // attach the httpOnly auth cookie
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON / empty body */
  }

  if (!res.ok) {
    if (res.status === 401) notifyUnauthorized();
    const err = new Error(
      data?.error?.message || `Request failed with status ${res.status}`
    );
    err.code = data?.error?.code || null;
    err.status = res.status;
    throw err;
  }

  return data?.data ?? data;
}

export default {
  get: (path, opts) => request(path, { ...opts, method: 'GET' }),
  post: (path, body, opts) => request(path, { ...opts, method: 'POST', body }),
  put: (path, body, opts) => request(path, { ...opts, method: 'PUT', body }),
  del: (path, opts) => request(path, { ...opts, method: 'DELETE' }),
};