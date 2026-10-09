export class ApiError extends Error {
  readonly status: number;
  /** Extra data sent by the server (e.g. field errors, or the reason a launch needs confirmation). */
  readonly details: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** Dispatched on window when the API answers 401 (no valid session). */
export const UNAUTHORIZED_EVENT = 'ams:unauthorized';

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const data: unknown = await response.json().catch(() => null);
  // Session expired or signed out elsewhere: the app goes back to the login screen.
  if (response.status === 401 && path !== '/auth/login') window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  if (!response.ok) {
    const message =
      data && typeof data === 'object' && 'message' in data && typeof data.message === 'string'
        ? data.message
        : `Erro ${response.status}`;
    const details = data && typeof data === 'object' && 'details' in data ? data.details : undefined;
    throw new ApiError(response.status, message, details);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};
