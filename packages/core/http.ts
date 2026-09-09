import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

export const token = () => randomBytes(32).toString('base64url');
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function equalSecret(a: string, b: string) {
  return timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
}
export function safeLogger(enabled: boolean) {
  return enabled
    ? {
        serializers: {
          req: (req: { method?: string; url?: string }) => ({
            method: req.method,
            path: req.url?.split('?')[0],
          }),
          res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
          err: () => ({ type: 'ServiceError', message: 'Request failed', stack: '' }),
        },
      }
    : false;
}
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export function requireBrowser(req: FastifyRequest, origin: string) {
  if (
    req.headers.origin !== origin ||
    (req.headers['x-worldsbay'] !== '1' && req.headers['x-yoworlds'] !== '1' && req.headers['x-pocketbeyond'] !== '1') ||
    req.headers.authorization
  )
    throw new HttpError(403, 'This action requires the matching browser origin.');
}
export function errors(app: FastifyInstance, centralOrigin?: string) {
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ZodError)
      return reply.code(400).send({ error: 'Invalid request.', details: error.issues.map((i) => i.message) });
    const e = error as Error & { statusCode?: number };
    const status = e.statusCode ?? 500;
    if (status >= 500) req.log.error({ event: 'request_failed', status }, 'Request failed');
    return reply.code(status).send({
      error: status >= 500 ? 'The service is temporarily unavailable. Return Home and retry.' : e.message,
    });
  });
  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer');
    reply
      .header('X-Frame-Options', 'DENY')
      .header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    reply.header(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' data: blob: ${centralOrigin ? new URL(centralOrigin).origin : ''} ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
    );
    if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
  });
}
export async function fetchJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(5000) });
  } catch {
    throw new HttpError(503, 'The central service could not be reached. Return Home to retry.');
  }
  const value = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new HttpError(response.status, value.error ?? 'Request failed.');
  return value;
}
export async function worldReachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url + '/health', { signal: AbortSignal.timeout(1500) });
    return response.ok && ((await response.json()) as { ok?: boolean }).ok === true;
  } catch {
    return false;
  }
}
