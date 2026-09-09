import type { FastifyInstance } from 'fastify';
import { HttpError } from './http.js';

/** Bounded process-local abuse control; use proxy limits as a second layer. */
export function installRateLimit(app: FastifyInstance, now = Date.now) {
  const buckets = new Map<string, { count: number; until: number }>();
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/') && !path.startsWith('/internal/') && path !== '/enter') return;
    const auth = path.startsWith('/api/auth/') || path.startsWith('/api/worlds/');
    const key = `${req.ip}:${auth ? 'auth' : 'api'}`;
    let bucket = buckets.get(key);
    if (!bucket || bucket.until <= now()) {
      if (buckets.size >= 10_000) {
        for (const [id, value] of buckets) if (value.until <= now()) buckets.delete(id);
        if (buckets.size >= 10_000) throw new HttpError(503, 'Please try again shortly.');
      }
      bucket = { count: 0, until: now() + 60_000 };
      buckets.set(key, bucket);
    }
    if (++bucket.count > (auth ? 12 : 600)) {
      reply.header('Retry-After', Math.max(1, Math.ceil((bucket.until - now()) / 1000)));
      throw new HttpError(429, 'Too many requests. Please wait a minute.');
    }
  });
  app.addHook('onClose', async () => {
    buckets.clear();
  });
}
