import type { RequestHandler } from 'express';
import type { z } from 'zod';

/**
 * Validates and replaces `req.body` with the parsed value. A ZodError is
 * passed to the error handler, which turns it into a 400 response.
 */
export function validateBody<S extends z.ZodType>(schema: S): RequestHandler {
  return (req, _res, next) => {
    req.body = schema.parse(req.body);
    next();
  };
}

/**
 * Validates `req.query` / `req.params`. Express 5 makes `req.query` read-only,
 * so parsed values are stored on `res.locals`.
 */
export function validateQuery<S extends z.ZodType>(schema: S): RequestHandler {
  return (req, res, next) => {
    res.locals.query = schema.parse(req.query);
    next();
  };
}

export function validateParams<S extends z.ZodType>(schema: S): RequestHandler {
  return (req, res, next) => {
    res.locals.params = schema.parse(req.params);
    next();
  };
}
