/**
 * Central error handling.
 *
 * Express 5 auto-forwards rejected promises from handlers, so route code no
 * longer needs try/catch → next(err) boilerplate; anything thrown lands here.
 */
import { ZodError } from 'zod';
import { ApiError, fail } from '../utils/http.js';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';

export function notFound(req, res) {
  return fail(res, 404, 'NOT_FOUND', `No route matches ${req.method} ${req.originalUrl}`);
}

// Express identifies error middleware by arity, so `next` must stay declared.
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof ApiError) {
    return fail(res, err.status, err.code, err.message, err.details);
  }

  if (err instanceof ZodError) {
    return fail(
      res, 400, 'VALIDATION_ERROR', 'Request failed validation',
      err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    );
  }

  // Duplicate key on a unique index (e.g. two registrations racing on email).
  if (err?.code === 11000) {
    return fail(res, 409, 'CONFLICT', 'That value is already taken', {
      fields: Object.keys(err.keyPattern ?? {}),
    });
  }

  if (err?.name === 'ValidationError') {
    return fail(
      res, 400, 'VALIDATION_ERROR', 'Request failed validation',
      Object.values(err.errors ?? {}).map((e) => ({ field: e.path, message: e.message })),
    );
  }

  if (err?.type === 'entity.parse.failed') {
    return fail(res, 400, 'MALFORMED_JSON', 'Request body is not valid JSON');
  }

  logger.error({ err }, 'Unhandled error');

  // Never leak a stack trace to a client in production.
  return fail(
    res, 500, 'INTERNAL_ERROR', 'Something went wrong on the server',
    env.NODE_ENV === 'production' ? undefined : { message: err?.message },
  );
}
