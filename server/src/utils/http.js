/**
 * The single response envelope.
 *
 * docs/02_TRD.md §10: every response is { success, data } or
 * { success: false, error: { code, message, details? } }. One envelope, no
 * exceptions: the frontend should never have to guess a response's shape.
 */

export function ok(res, data, status = 200) {
  return res.status(status).json({ success: true, data });
}

export function fail(res, status, code, message, details) {
  const error = { code, message };
  if (details !== undefined) error.details = details;
  return res.status(status).json({ success: false, error });
}

/**
 * An error carrying an HTTP status and a stable machine-readable code.
 * Express 5 auto-forwards rejected promises, so handlers can just throw these.
 */
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(message, details) {
    return new ApiError(400, 'BAD_REQUEST', message, details);
  }
  static unauthorized(message = 'Authentication required') {
    return new ApiError(401, 'UNAUTHORIZED', message);
  }
  static forbidden(message = 'Not permitted') {
    return new ApiError(403, 'FORBIDDEN', message);
  }
  static notFound(message = 'Not found') {
    return new ApiError(404, 'NOT_FOUND', message);
  }
  static conflict(message, details) {
    return new ApiError(409, 'CONFLICT', message, details);
  }
}
