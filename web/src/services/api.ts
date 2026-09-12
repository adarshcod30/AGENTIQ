/**
 * The API client.
 *
 * ⚠️ THE BASE URL IS READ FROM THE ENVIRONMENT.
 *
 * A hardcoded `baseURL: 'http://localhost:3001/api'` would make every build, on
 * every host, call the developer's laptop, and the app could not be deployed
 * anywhere.
 */
import axios, { AxiosError } from 'axios';

/** Falls back to localhost ONLY for local development convenience. */
export const API_BASE_URL: string =
  import.meta.env.VITE_API_URL ?? 'http://localhost:3001/api';

/**
 * A misconfigured base URL produces a 404 on EVERY call with no clue why. The
 * classic cause is setting VITE_API_URL without the /api segment, so
 * /auth/login resolves to http://host/auth/login. Warning at
 * startup costs nothing and saves an hour of confused debugging.
 */
if (import.meta.env.DEV && !/\/api\/?$/.test(API_BASE_URL)) {
  console.warn(
    `[AGENTIQ] VITE_API_URL is "${API_BASE_URL}", which does not end in /api. ` +
    'Every request will 404. It should be e.g. http://localhost:3001/api',
  );
}

/** The single response envelope: docs/02_TRD.md §10. */
export interface ApiSuccess<T> { success: true; data: T }
export interface ApiFailure {
  success: false;
  error: { code: string; message: string; details?: unknown };
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const http = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true,
  timeout: 60_000,
});

/** Attaches the bearer token. Read lazily so a fresh login takes effect at once. */
let authToken: string | null = null;
export function setAuthToken(token: string | null) {
  authToken = token;
}
export function getAuthToken() {
  return authToken;
}

http.interceptors.request.use((config) => {
  if (authToken) config.headers.Authorization = `Bearer ${authToken}`;
  // The permission sheet grants are scoped per session, so every request
  // carries the session id the grants were recorded against.
  const sessionId = sessionStorage.getItem('agentiq-session-id');
  if (sessionId) config.headers['x-session-id'] = sessionId;
  return config;
});

/** Handlers registered by the app for cross-cutting responses. */
type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler | null = null;
export function setUnauthorizedHandler(fn: UnauthorizedHandler | null) {
  onUnauthorized = fn;
}

http.interceptors.response.use(
  (response) => response,
  (error: AxiosError<ApiFailure>) => {
    // docs/03_App_Flow.md A2: 401 clears auth, redirects to login, toasts
    // "Session expired".
    if (error.response?.status === 401) onUnauthorized?.();

    const payload = error.response?.data;
    if (payload && payload.success === false) {
      return Promise.reject(new ApiError(
        error.response!.status,
        payload.error.code,
        payload.error.message,
        payload.error.details,
      ));
    }

    // Network failure, timeout, or a non-envelope response.
    return Promise.reject(new ApiError(
      error.response?.status ?? 0,
      error.code === 'ECONNABORTED' ? 'TIMEOUT' : 'NETWORK_ERROR',
      error.response?.status
        ? `The server returned ${error.response.status}.`
        : 'Could not reach the server. Is it running?',
    ));
  },
);

/** Unwraps the { success, data } envelope so callers deal in plain data. */
export async function apiGet<T>(url: string, params?: Record<string, unknown>): Promise<T> {
  const { data } = await http.get<ApiSuccess<T>>(url, { params });
  return data.data;
}

export async function apiPost<T>(url: string, body?: unknown): Promise<T> {
  const { data } = await http.post<ApiSuccess<T>>(url, body);
  return data.data;
}

export async function apiDelete<T>(url: string, body?: unknown): Promise<T> {
  const { data } = await http.delete<ApiSuccess<T>>(url, { data: body });
  return data.data;
}

export async function apiPatch<T>(url: string, body?: unknown): Promise<T> {
  const { data } = await http.patch<ApiSuccess<T>>(url, body);
  return data.data;
}

export async function apiPut<T>(url: string, body?: unknown): Promise<T> {
  const { data } = await http.put<ApiSuccess<T>>(url, body);
  return data.data;
}

/** A stable session id, so grants persist across a page reload but not a tab close. */
export function ensureSessionId(): string {
  let id = sessionStorage.getItem('agentiq-session-id');
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem('agentiq-session-id', id);
  }
  return id;
}
