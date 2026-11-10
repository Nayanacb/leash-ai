import type { ApiError } from '@leash/shared';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';

/** Errors raised by express.json() carry a `type` and `status`. */
interface BodyParserError extends Error {
  type?: string;
  status?: number;
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(AppError.notFound(`No route for ${req.method} ${req.path}`));
};

export function createErrorHandler(options: {
  exposeInternalErrors: boolean;
}): ErrorRequestHandler {
  // Express identifies error handlers by arity, so all four parameters are required.
  return (err: unknown, req, res, _next) => {
    let status = 500;
    let body: ApiError['error'] = {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      requestId: req.requestId,
    };

    if (err instanceof AppError) {
      status = err.status;
      body = { code: err.code, message: err.message, requestId: req.requestId };
      if (err.details !== undefined) body.details = err.details;
    } else if (err instanceof ZodError) {
      status = 400;
      body = {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        requestId: req.requestId,
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      };
    } else if (isBodyParserError(err)) {
      status = err.status ?? 400;
      body =
        err.type === 'entity.too.large'
          ? {
              code: 'PAYLOAD_TOO_LARGE',
              message: 'Request body too large',
              requestId: req.requestId,
            }
          : {
              code: 'INVALID_JSON',
              message: 'Request body is not valid JSON',
              requestId: req.requestId,
            };
    } else if (options.exposeInternalErrors && err instanceof Error) {
      body.details = { name: err.name, message: err.message };
    }

    if (status >= 500) {
      req.log.error({ err }, 'request failed');
    } else {
      req.log.info({ code: body.code, status }, 'request rejected');
    }

    if (res.headersSent) return;
    res.status(status).json({ error: body } satisfies ApiError);
  };
}

function isBodyParserError(err: unknown): err is BodyParserError {
  return (
    err instanceof Error &&
    typeof (err as BodyParserError).type === 'string' &&
    (err as BodyParserError).type!.startsWith('entity.')
  );
}
