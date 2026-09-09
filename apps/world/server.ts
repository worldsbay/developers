import { WorldClient, RequestError } from '@worldsbay/api/server';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import serveStatic from '@fastify/static';
import { z } from 'zod';
import { installRoom } from '../../packages/room/server.js';
import type { WorldRoom } from '../../packages/room/server.js';
import { defaultDefinition, publicDefinition, hubPortals } from '../../packages/wire/world.js';
import type { Config } from '../../packages/core/config.js';
import type { Appearance } from '../../packages/core/contract.js';
import { publicWorldSchema } from '../../packages/core/registry.js';
import { publicJson } from '../../packages/core/public-fetch.js';
import type { World } from '../../packages/core/contract.js';
import { WorldAssetCache } from './asset-cache.js';
import { installRateLimit } from '../../packages/core/rate-limit.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  errors,
  token,
  digest,
  requireBrowser,
  HttpError,
  worldReachable,
  safeLogger,
} from '../../packages/core/http.js';

export type CentralTransport = <T>(
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
  grant?: string,
) => Promise<T>;
export async function createWorld(
  cfg: Config,
  worldId: string,
  options: {
    transport?: CentralTransport;
    probe?: (url: string) => Promise<boolean>;
    static?: boolean;
    now?: () => number;
    logger?: boolean;
    appearanceRefreshMs?: number;
    onRoom?: (room: WorldRoom) => void;
    clientRoot?: string;
    verification?: { worldId: string; challenge: string };
  } = {},
) {
  const world = cfg.worlds.find((w) => w.id === worldId);
  if (!world) throw new Error('Unknown world.');
  const app = Fastify({
    logger: safeLogger(options.logger ?? false),
    bodyLimit: 16_384,
    trustProxy: cfg.trustProxy,
  });
  errors(app, cfg.centralUrl);
  if (cfg.production) installRateLimit(app, options.now ?? Date.now);
  await app.register(cookie);
  if (options.verification) {
    const proof = z
      .object({ worldId: z.literal(worldId), challenge: z.string().min(40).max(100) })
      .strict()
      .parse(options.verification);
    app.get('/.well-known/worldsbay.json', async () => proof);
    app.get('/.well-known/pocketbeyond.json', async () => proof);
  }
  const now = options.now ?? Date.now;
  const cookieName = `${world.url.startsWith('https:') ? '__Host-' : ''}pb_${worldId}`;
  type LocalSession = { grant: string; expires: number; appearance?: Appearance };
  const sessions = new Map<string, LocalSession>();
  const definition = publicDefinition(
    world.definition ??
      defaultDefinition(
        world.id,
        world.name,
        cfg.worlds.filter((w) => w.id !== worldId).map((w) => w.id),
      ),
  );
  const publicWorld = publicWorldSchema.parse({
    id: world.id,
    name: world.name,
    description: world.description,
    url: world.url,
    entryPath: world.entryPath,
    accent: world.accent,
    definition,
  });
  const reads = new Map<string, Promise<Appearance>>();
  const assetCache = new WorldAssetCache(cfg.centralUrl, world.url, fetch, join(cfg.assetPath, 'characters'));
  if (cfg.production)
    app.get('/avatar-assets/:key', async (req, reply) => {
      const { key } = z.object({ key: z.string().regex(/^[a-f0-9]{64}\.glb$/) }).parse(req.params);
      return reply
        .header('Cache-Control', 'public, max-age=31536000, immutable')
        .type('model/gltf-binary')
        .send(await assetCache.get(key));
    });
  const worldApi = options.transport
    ? undefined
    : new WorldClient({
        centralUrl: cfg.centralUrl,
        worldId,
        worldSecret: cfg.worldSecrets[worldId],
        timeoutMs: 5000,
      });
  const central: CentralTransport =
    options.transport ??
    (async <T>(path: string, method: 'GET' | 'POST', body?: unknown, grant?: string) => {
      try {
        return await worldApi!.request<T>(path, method, body, grant);
      } catch (error) {
        // Preserve the adapter's HTTP status contract and authentication-failure handling.
        if (error instanceof RequestError) throw new HttpError(error.status || 503, error.message);
        throw error;
      }
    });
  let registryCache: { until: number; worlds: World[] } | undefined;
  async function destinations() {
    if (!cfg.production) return cfg.worlds;
    if (registryCache && registryCache.until > now()) return registryCache.worlds;
    const worlds = z
      .array(publicWorldSchema)
      .max(200)
      .parse(await central('/internal/worlds', 'GET'));
    registryCache = { worlds, until: now() + 30_000 };
    return worlds;
  }
  function localSession(value?: string) {
    const stored = sessions.get(digest(value ?? ''));
    if (!stored || stored.expires <= now())
      throw new HttpError(401, 'Your world session ended. Return Home to enter again.');
    return stored;
  }
  const session = (value?: string) => localSession(value).grant;
  async function appearance(stored: LocalSession, cached = false): Promise<Appearance> {
    let read = reads.get(stored.grant);
    if (!read) {
      read = central<Appearance>('/internal/appearance', 'GET', undefined, stored.grant);
      reads.set(stored.grant, read);
      void read.finally(() => reads.delete(stored.grant)).catch(() => {});
    }
    try {
      const original = await read;
      const value = cfg.production ? assetCache.appearance(original) : original;
      if (!stored.appearance || (value.revision ?? 1) >= (stored.appearance.revision ?? 1))
        stored.appearance = value;
      return stored.appearance;
    } catch (error) {
      if (
        cached &&
        stored.appearance &&
        stored.expires > now() &&
        !(error instanceof HttpError && [401, 403].includes(error.statusCode))
      )
        return stored.appearance;
      throw error;
    }
  }
  const roomService = installRoom(app, {
    origin: () => world.url,
    definition,
    now,
    refreshMs: options.appearanceRefreshMs,
    admit: async (req) => {
      const stored = localSession(app.parseCookie(req.headers.cookie ?? '')[cookieName]);
      const current = await appearance(stored, true);
      return {
        playerId: current.player.id,
        grant: stored.grant,
        expiresAt: stored.expires,
        appearance: current,
      };
    },
    refresh: async (grant) => {
      const stored = [...sessions.values()].find((s) => s.grant === grant);
      if (!stored) throw new HttpError(401, 'Session expired');
      return appearance(stored);
    },
  });
  options.onRoom?.(roomService.room);
  app.get('/health', async () => ({ ok: true, service: worldId }));
  async function availableDestinations() {
    const available = (await destinations()).filter((w) => w.id !== worldId);
    if (worldId === 'world-a') {
      definition.portals = hubPortals(available.map((w) => w.id));
      const edge = Math.max(
        10,
        ...definition.portals.map((p) => Math.max(Math.abs(p.position.x), Math.abs(p.position.z)) + 3),
      );
      definition.bounds = { minX: -edge, maxX: edge, minZ: -edge, maxZ: edge };
      publicWorld.definition = definition;
      return available.filter((w) => definition.portals.some((p) => p.target === w.id));
    }
    return available.filter((w) =>
      definition.portals.some((p) => p.target === w.id || p.target === 'random'),
    );
  }
  app.get('/api/config', async () => ({ world: publicWorld, homeUrl: cfg.centralUrl }));
  app.get('/enter', async (req, reply) => {
    try {
      const { ticket } = z.object({ ticket: z.string().min(20).max(200) }).parse(req.query);
      for (const [key, value] of sessions) if (value.expires <= now()) sessions.delete(key);
      if (sessions.size >= 256) {
        const active = new Set([...roomService.room.actors.values()].map((actor) => actor.grant));
        for (const [key, value] of sessions)
          if (!active.has(value.grant)) {
            sessions.delete(key);
            if (sessions.size < 256) break;
          }
      }
      if (sessions.size >= 256) throw new HttpError(503, 'World session capacity reached. Try again later.');
      const { session: grant, expiresAt } = await central<{ session: string; expiresAt: number }>(
        '/internal/exchange',
        'POST',
        {
          token: ticket,
        },
      );
      const local = token();
      sessions.set(digest(local), { grant, expires: expiresAt });
      try {
        await central('/internal/accept', 'POST', undefined, grant);
      } catch (error) {
        sessions.delete(digest(local));
        throw error;
      }
      reply.setCookie(cookieName, local, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: world.url.startsWith('https:'),
        maxAge: 3600,
      });
      // Strip the single-use ticket before any scene assets are loaded.
      return reply.redirect('/');
    } catch {
      return reply.redirect('/?entry=failed');
    }
  });
  app.get('/api/session', async (req) => {
    const local = localSession(req.cookies[cookieName]);
    const available = await availableDestinations();
    return {
      world: publicWorld,
      homeUrl: cfg.centralUrl,
      destinations: available.map((w) => publicWorldSchema.parse(w)),
      appearance: await appearance(local, true),
      expiresAt: local.expires,
    };
  });
  app.get('/api/appearance', async (req) => appearance(localSession(req.cookies[cookieName])));
  app.get('/api/room-metrics', async (req) => {
    session(req.cookies[cookieName]);
    return roomService.diagnostics();
  });
  app.post('/api/travel', async (req) => {
    requireBrowser(req, world.url);
    const body = z.object({ worldId: z.string() }).strict().parse(req.body);
    session(req.cookies[cookieName]);
    if (
      body.worldId === 'random' &&
      (worldId === 'world-a' || definition.portals.some((p) => p.target === 'random'))
    )
      return central('/internal/travel', 'POST', body, session(req.cookies[cookieName]));
    const destination = (await availableDestinations()).find((w) => w.id === body.worldId);
    if (
      !destination ||
      destination.id === worldId ||
      !definition.portals.some((p) => p.target === destination.id || p.target === 'random')
    )
      throw new HttpError(400, 'Choose another registered world.');
    const probe =
      options.probe ??
      (cfg.production
        ? async (url: string) => {
            try {
              return ((await publicJson(url + '/health')) as { ok?: boolean }).ok === true;
            } catch {
              return false;
            }
          }
        : worldReachable);
    if (!(await probe(destination.url)))
      throw new HttpError(
        503,
        'The destination is offline. Stay here or return Home, then retry when it is running.',
      );
    return central('/internal/travel', 'POST', body, session(req.cookies[cookieName]));
  });
  app.post('/api/store', async (req) => {
    requireBrowser(req, world.url);
    const body = z
      .object({
        selectedItem: z
          .string()
          .regex(/^[a-z0-9-]+$/)
          .optional(),
      })
      .strict()
      .parse(req.body ?? {});
    return central('/internal/store', 'POST', body, session(req.cookies[cookieName]));
  });
  app.get('/api/collection', async (req) => {
    const catalogue = await central<import('../../packages/core/contract.js').Item[]>(
      '/internal/catalogue',
      'GET',
      undefined,
      session(req.cookies[cookieName]),
    );
    return definition.collection.length
      ? catalogue.filter((item) => definition.collection.includes(item.id))
      : catalogue;
  });
  const cleanup = setInterval(() => {
    for (const [key, value] of sessions) if (value.expires <= now()) sessions.delete(key);
  }, 60_000).unref();
  app.addHook('onClose', async () => {
    clearInterval(cleanup);
    sessions.clear();
    assetCache.clear();
  });
  if (options.static !== false) {
    await app.register(serveStatic, { root: cfg.clientPath, prefix: '/client/' });
    if (options.clientRoot)
      await app.register(serveStatic, {
        root: options.clientRoot,
        prefix: '/world-content/',
        decorateReply: false,
      });
    app.get('/', async (_req, reply) => {
      reply.header('Cache-Control', 'no-cache');
      const html = await readFile(
        options.clientRoot
          ? join(options.clientRoot, 'index.html')
          : join(cfg.clientPath, 'apps/world/index.html'),
        'utf8',
      );
      return reply.type('text/html').send(html.replaceAll('__HOME_URL__', cfg.centralUrl));
    });
  }
  await app.ready();
  return app;
}
