import type { ApiResult } from './types';

// ============================================================
// Session identity — stable for app lifetime
// ============================================================

export const sessionId = crypto.randomUUID();
let userId = '';
let databaseId = '';

export function setUserId(id: string) { userId = id; }
export function getUserId() { return userId; }
export function setDatabaseId(id: string) { databaseId = id; }
export function getDatabaseId() { return databaseId; }

// ============================================================
// Headers
// ============================================================

function dbHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Session-ID': sessionId,
  };
  if (databaseId) h['X-Database-ID'] = databaseId;
  if (userId) h['X-User-ID'] = userId;
  return h;
}

// ============================================================
// Core fetch wrapper
// ============================================================

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const opts: RequestInit = {
    method,
    headers: dbHeaders(),
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(path, opts);
    const text = await res.text();
    let data: T;
    try {
      data = JSON.parse(text);
    } catch {
      data = text as unknown as T;
    }
    return { ok: res.ok, data, status: res.status };
  } catch (err) {
    return {
      ok: false,
      data: (err instanceof Error ? err.message : String(err)) as unknown as T,
      status: 0,
    };
  }
}

// ============================================================
// Typed helpers
// ============================================================

export function get<T>(path: string) {
  return request<T>('GET', path);
}

export function post<T>(path: string, body?: unknown) {
  return request<T>('POST', path, body);
}

export function put<T>(path: string, body?: unknown) {
  return request<T>('PUT', path, body);
}

export function del<T>(path: string, body?: unknown) {
  return request<T>('DELETE', path, body);
}

export function patch<T>(path: string, body?: unknown) {
  return request<T>('PATCH', path, body);
}
