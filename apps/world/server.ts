import { WorldClient, RequestError } from '@worldsbay/api/server';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import serveStatic from '@fastify/static';
import { z } from 'zod';
import { ConnectingPlayers } from './presence.js';
import { WORLD_HEARTBEAT_MS, type WorldHeartbeat } from '../../packages/wire/presence.js';
import { installRoom } from '../../packages/room/server.js';
import type { WorldRoom } from '../../packages/room/server.js';
import type { Admission } from '../../packages/room/server.js';
import type { FastifyInstance } from 'fastify';
import type { IncomingMessage } from 'node:http';
import { defaultDefinition, publicDefinition, hubPortals } from '../../packages/wire/world.js';
import type { Config } from '../../packages/core/config.js';
import type { Appearance, WorldAccount } from '../../packages/core/contract.js';
import { publicWorldSchema } from '../../packages/core/registry.js';
import { portalGroup, portalMatchesWorld, portalTargetSchema } from '../../packages/wire/world-metadata.js';
import { publicJson } from '../../packages/core/public-fetch.js';
import type { World } from '../../packages/core/contract.js';
import { WorldAssetCache } from './asset-cache.js';
import { installRateLimit } from '../../packages/core/rate-limit.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
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
/** A world-specific game can reuse the existing single-use ticket and appearance service. */
export type WorldGameContext = {
  app: FastifyInstance;
  world: World;
  now: () => number;
  admit: (req: IncomingMessage) => Promise<Admission>;
  refresh: (grant: string) => Promise<Appearance>;
};
export type WorldGameService = {
  maxPlayers?: number;
  activeGrants: () => string[];
  diagnostics: () => unknown;
};
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
    heartbeatMs?: number;
    onRoom?: (room: WorldRoom) => void;
    clientRoot?: string;
    picturePath?: string;
    installGame?: (context: WorldGameContext) => WorldGameService | Promise<WorldGameService>;
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
  // Top-level cross-origin account POSTs need a real Origin header. A no-referrer
  // document policy makes browsers send Origin:null; strict-origin retains only
  // the world origin and never exposes entry codes or other URL paths/queries.
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Referrer-Policy', 'strict-origin');
  });
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
  const resumeCookieName = `${cookieName}_resume`;
  const rememberSeconds = 30 * 86_400;
  const cookieOptions = {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: world.url.startsWith('https:'),
  };
  type LocalSession = { grant: string; expires: number; appearance?: Appearance };
  const sessions = new Map<string, LocalSession>();
  const connecting = new ConnectingPlayers(now);
  function rememberSession(key: string, stored: LocalSession) {
    sessions.set(key, stored);
    connecting.begin(stored.grant);
  }
  const accountFlows = new Map<string, { verifier: string; browserHash: string; expiresAt: number }>();
  const accountFlowCookie = (state: string) => `${cookieName}_auth_${state}`;
  const starts = new Map<string, Promise<{ local: string; stored: LocalSession; resumeExpiresAt: number }>>();
  const entryLimits = new Map<string, { count: number; until: number }>();
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
    thumbnail: world.thumbnail,
    tags: world.tags,
    group: world.group,
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
      throw new HttpError(401, 'Continue your explorer or play as a guest here.');
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
  const gameContext: WorldGameContext = {
    app,
    world,
    now,
    admit: async (req) => {
      const stored = localSession(app.parseCookie(req.headers.cookie ?? '')[cookieName]);
      const current = await appearance(stored, true);
      connecting.finish(stored.grant);
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
  };
  let gameService: WorldGameService;
  if (options.installGame) gameService = await options.installGame(gameContext);
  else {
    const roomService = installRoom(app, {
      ...gameContext,
      origin: () => world.url,
      definition,
      refreshMs: options.appearanceRefreshMs,
    });
    options.onRoom?.(roomService.room);
    gameService = {
      activeGrants: () => [...roomService.room.actors.values()].map((actor) => actor.grant),
      diagnostics: roomService.diagnostics,
    };
  }
  app.get('/health', async () => ({ ok: true, service: worldId }));
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let reporting: Promise<void> | undefined;
  let stopping = false;
  const endpoint = new URL(world.url);
  const publicPort = Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80));
  async function reportPresence(online: boolean) {
    const counts = online
      ? connecting.count(gameService.activeGrants(), [...sessions.values()])
      : { connectedPlayers: 0, connectingPlayers: 0 };
    const heartbeat: WorldHeartbeat = {
      online,
      ...counts,
      maxPlayers: gameService.maxPlayers ?? definition.roomLimit,
      ports: [
        { protocol: endpoint.protocol === 'https:' ? 'https' : 'http', port: publicPort },
        { protocol: endpoint.protocol === 'https:' ? 'wss' : 'ws', port: publicPort },
      ],
      portals: definition.portals.map((portal) => portal.target),
    };
    try {
      await central('/internal/worlds/heartbeat', 'POST', heartbeat);
    } catch {
      app.log.warn('World presence heartbeat failed; it will retry on the next interval.');
    }
  }
  function heartbeat() {
    if (stopping || reporting) return;
    reporting = reportPresence(true).finally(() => {
      reporting = undefined;
    });
    return reporting;
  }
  app.addHook('onListen', async () => {
    if (stopping) return;
    heartbeatTimer = setInterval(() => {
      void heartbeat();
    }, options.heartbeatMs ?? WORLD_HEARTBEAT_MS).unref();
    await heartbeat();
  });
  app.addHook('preClose', async () => {
    stopping = true;
    clearInterval(heartbeatTimer);
    await reporting;
    if (heartbeatTimer) await reportPresence(false);
  });
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
    return available.filter((w) => definition.portals.some((p) => portalMatchesWorld(p.target, w)));
  }
  function roomForSession() {
    for (const [key, value] of sessions) if (value.expires <= now()) sessions.delete(key);
    if (sessions.size >= 256) {
      const active = new Set(gameService.activeGrants());
      for (const [key, value] of sessions)
        if (!active.has(value.grant)) {
          sessions.delete(key);
          if (sessions.size < 256) break;
        }
    }
    if (sessions.size >= 256) throw new HttpError(503, 'World session capacity reached. Try again later.');
  }
  function setResumeCookie(reply: FastifyReply, secret: string, expiresAt = now() + rememberSeconds * 1000) {
    reply.setCookie(resumeCookieName, secret, {
      ...cookieOptions,
      maxAge: Math.max(1, Math.floor((expiresAt - now()) / 1000)),
    });
  }
  function resumeToken(req: FastifyRequest, reply: FastifyReply, create: boolean) {
    const previous = req.cookies[resumeCookieName];
    if (previous) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(previous))
        throw new HttpError(401, 'Your remembered world session is invalid.');
      return previous;
    }
    if (!create) throw new HttpError(401, 'No explorer is remembered in this browser yet.');
    const secret = token();
    // Set before the central request so a failed response can be retried with the same identity.
    setResumeCookie(reply, secret);
    return secret;
  }
  async function sessionResult(local: LocalSession) {
    const available = await availableDestinations();
    return {
      world: publicWorld,
      homeUrl: cfg.centralUrl,
      destinations: available.map((w) => publicWorldSchema.parse(w)),
      appearance: await appearance(local, true),
      expiresAt: local.expires,
    };
  }
  function limitEntry(req: FastifyRequest, reply: FastifyReply) {
    let bucket = entryLimits.get(req.ip);
    if (!bucket || bucket.until <= now()) {
      for (const [key, value] of entryLimits) if (value.until <= now()) entryLimits.delete(key);
      if (entryLimits.size >= 10_000) throw new HttpError(503, 'Entry is busy. Please retry shortly.');
      entryLimits.set(req.ip, (bucket = { count: 0, until: now() + 60_000 }));
    }
    if (++bucket.count > 12) {
      reply.header('Retry-After', Math.max(1, Math.ceil((bucket.until - now()) / 1000)));
      throw new HttpError(429, 'Too many entry attempts. Please wait a minute.');
    }
  }
  app.get('/api/config', async (req, reply) => {
    // A first-party random seed allows concurrent Play requests to converge on one guest.
    if (!req.cookies[resumeCookieName]) setResumeCookie(reply, token());
    return { world: publicWorld, homeUrl: cfg.centralUrl };
  });
  for (const [path, create] of [
    ['/api/guest', true],
    ['/api/session/resume', false],
  ] as const)
    app.post(path, async (req, reply) => {
      requireBrowser(req, world.url);
      const body = create
        ? z
            .object({ newGuest: z.boolean().optional() })
            .strict()
            .parse(req.body ?? {})
        : z
            .object({})
            .strict()
            .parse(req.body ?? {});
      const newGuest = 'newGuest' in body && body.newGuest;
      limitEntry(req, reply);
      const previous = sessions.get(digest(req.cookies[cookieName] ?? ''));
      if (!newGuest && previous && previous.expires > now() + 60_000) {
        try {
          return await sessionResult(previous);
        } catch (error) {
          if (!(error instanceof HttpError && error.statusCode === 401)) throw error;
        }
      }
      const secret = newGuest ? token() : resumeToken(req, reply, create);
      if (newGuest) setResumeCookie(reply, secret);
      const key = `${create ? 'guest' : 'resume'}:${digest(secret)}`;
      let starting = starts.get(key);
      if (!starting) {
        roomForSession();
        starting = (async () => {
          const result = await central<{ session: string; expiresAt: number; resumeExpiresAt: number }>(
            create ? '/internal/guest' : '/internal/session/resume',
            'POST',
            { resumeToken: secret },
          );
          roomForSession();
          const local = token();
          const stored = { grant: result.session, expires: result.expiresAt };
          rememberSession(digest(local), stored);
          return { local, stored, resumeExpiresAt: result.resumeExpiresAt };
        })();
        starts.set(key, starting);
        void starting.finally(() => starts.delete(key)).catch(() => {});
      }
      const result = await starting;
      reply.setCookie(cookieName, result.local, {
        ...cookieOptions,
        maxAge: Math.max(1, Math.floor((result.stored.expires - now()) / 1000)),
      });
      setResumeCookie(reply, secret, result.resumeExpiresAt);
      return sessionResult(result.stored);
    });
  async function enterWithCode(reply: FastifyReply, code: string, verifier?: string) {
    roomForSession();
    const { session: grant, expiresAt } = await central<{ session: string; expiresAt: number }>(
      '/internal/exchange',
      'POST',
      {
        token: code,
        ...(verifier ? { codeVerifier: verifier } : {}),
      },
    );
    const local = token();
    const remembered = token();
    rememberSession(digest(local), { grant, expires: expiresAt });
    try {
      setResumeCookie(reply, remembered);
      const accepted = await central<{ ok: boolean; resumeExpiresAt: number }>(
        '/internal/accept',
        'POST',
        { resumeToken: remembered },
        grant,
      );
      setResumeCookie(reply, remembered, accepted.resumeExpiresAt);
    } catch (error) {
      sessions.delete(digest(local));
      throw error;
    }
    reply.setCookie(cookieName, local, { ...cookieOptions, maxAge: 3600 });
    // Strip entry credentials before any scene assets are loaded.
    return reply.redirect('/');
  }
  app.get('/enter', async (req, reply) => {
    try {
      const { ticket } = z.object({ ticket: z.string().min(20).max(200) }).parse(req.query);
      return await enterWithCode(reply, ticket);
    } catch {
      return reply.redirect('/?entry=failed');
    }
  });
  app.get('/auth/callback', async (req, reply) => {
    try {
      const { code, state } = z
        .object({
          code: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
          state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        })
        .strict()
        .parse(req.query);
      const pending = accountFlows.get(state);
      if (
        !pending ||
        pending.expiresAt <= now() ||
        pending.browserHash !== digest(req.cookies[accountFlowCookie(state)] ?? '')
      )
        throw new HttpError(401, 'Open sign-in again from this game.');
      limitEntry(req, reply);
      accountFlows.delete(state);
      reply.clearCookie(accountFlowCookie(state), { path: '/', secure: cookieOptions.secure });
      return await enterWithCode(reply, code, pending.verifier);
    } catch {
      return reply.redirect('/?entry=failed');
    }
  });
  app.get('/api/session', async (req) => sessionResult(localSession(req.cookies[cookieName])));
  app.get('/api/account', async (req) =>
    central<WorldAccount>('/internal/account', 'GET', undefined, session(req.cookies[cookieName])),
  );
  app.post('/api/account/context', async (req, reply) => {
    requireBrowser(req, world.url);
    const request = z
      .object({ hosted: z.boolean().optional() })
      .strict()
      .parse(req.body ?? {});
    limitEntry(req, reply);
    const state = request.hosted ? token() : undefined;
    const verifier = state ? token() : undefined;
    const proof = state ? token() : undefined;
    const handoff =
      state && verifier
        ? { state, codeChallenge: createHash('sha256').update(verifier).digest('base64url') }
        : {};
    if (state) {
      for (const [key, flow] of accountFlows) if (flow.expiresAt <= now()) accountFlows.delete(key);
      if (accountFlows.size >= 2_000) throw new HttpError(503, 'Sign-in is busy. Please try again shortly.');
    }
    let current = sessions.get(digest(req.cookies[cookieName] ?? ''));
    if ((!current || current.expires <= now()) && req.cookies[resumeCookieName]) {
      try {
        const result = await central<{ session: string; expiresAt: number; resumeExpiresAt: number }>(
          '/internal/session/resume',
          'POST',
          { resumeToken: resumeToken(req, reply, false) },
        );
        roomForSession();
        current = { grant: result.session, expires: result.expiresAt };
        const local = token();
        rememberSession(digest(local), current);
        reply.setCookie(cookieName, local, {
          ...cookieOptions,
          maxAge: Math.max(1, Math.floor((current.expires - now()) / 1000)),
        });
        setResumeCookie(reply, req.cookies[resumeCookieName], result.resumeExpiresAt);
      } catch (error) {
        if (!(error instanceof HttpError && error.statusCode === 401)) throw error;
        current = undefined;
      }
    }
    let result;
    try {
      result = await central('/internal/account-context', 'POST', handoff, current?.grant);
    } catch (error) {
      // A revoked grant cannot authorize guest upgrade; fresh password sign-in remains available.
      if (!(error instanceof HttpError && error.statusCode === 401) || !current) throw error;
      result = await central('/internal/account-context', 'POST', handoff);
    }
    if (state && verifier && proof) {
      accountFlows.set(state, { verifier, browserHash: digest(proof), expiresAt: now() + 60 * 60_000 });
      reply.setCookie(accountFlowCookie(state), proof, { ...cookieOptions, maxAge: 60 * 60 });
    }
    return result;
  });
  app.post('/api/account/complete', async (req, reply) => {
    requireBrowser(req, world.url);
    const { ticket } = z
      .object({ ticket: z.string().min(20).max(200) })
      .strict()
      .parse(req.body);
    limitEntry(req, reply);
    roomForSession();
    const { session: grant, expiresAt } = await central<{ session: string; expiresAt: number }>(
      '/internal/exchange',
      'POST',
      { token: ticket },
    );
    const remembered = token();
    setResumeCookie(reply, remembered);
    const accepted = await central<{ ok: boolean; resumeExpiresAt: number }>(
      '/internal/accept',
      'POST',
      { resumeToken: remembered },
      grant,
    );
    const local = token();
    const stored = { grant, expires: expiresAt };
    rememberSession(digest(local), stored);
    setResumeCookie(reply, remembered, accepted.resumeExpiresAt);
    reply.setCookie(cookieName, local, {
      ...cookieOptions,
      maxAge: Math.max(1, Math.floor((expiresAt - now()) / 1000)),
    });
    return sessionResult(stored);
  });
  app.post('/api/account/logout', async (req, reply) => {
    requireBrowser(req, world.url);
    z.object({})
      .strict()
      .parse(req.body ?? {});
    limitEntry(req, reply);
    const current = sessions.get(digest(req.cookies[cookieName] ?? ''));
    await central(
      '/internal/account/logout',
      'POST',
      {
        ...(req.cookies[resumeCookieName] ? { resumeToken: req.cookies[resumeCookieName] } : {}),
      },
      current?.grant,
    );
    sessions.delete(digest(req.cookies[cookieName] ?? ''));
    reply.clearCookie(cookieName, { path: '/', secure: cookieOptions.secure });
    reply.clearCookie(resumeCookieName, { path: '/', secure: cookieOptions.secure });
    return { ok: true };
  });
  app.get('/api/appearance', async (req) => appearance(localSession(req.cookies[cookieName])));
  app.get('/api/room-metrics', async (req) => {
    session(req.cookies[cookieName]);
    return gameService.diagnostics();
  });
  app.post('/api/travel', async (req) => {
    requireBrowser(req, world.url);
    const body = z.object({ worldId: portalTargetSchema }).strict().parse(req.body);
    session(req.cookies[cookieName]);
    if (
      (body.worldId === 'random' || portalGroup(body.worldId) !== undefined) &&
      ((worldId === 'world-a' && body.worldId === 'random') ||
        definition.portals.some((p) => p.target === body.worldId))
    )
      return central('/internal/travel', 'POST', body, session(req.cookies[cookieName]));
    const destination = (await availableDestinations()).find((w) => w.id === body.worldId);
    if (
      !destination ||
      destination.id === worldId ||
      !definition.portals.some((p) => portalMatchesWorld(p.target, destination))
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
    for (const [key, value] of accountFlows) if (value.expiresAt <= now()) accountFlows.delete(key);
  }, 60_000).unref();
  app.addHook('onClose', async () => {
    clearInterval(cleanup);
    sessions.clear();
    accountFlows.clear();
    starts.clear();
    entryLimits.clear();
    assetCache.clear();
  });
  if (options.static !== false) {
    await app.register(serveStatic, { root: cfg.clientPath, prefix: '/client/' });
    // Each world serves its own file; the directory only embeds the public URL.
    const picturePath =
      options.picturePath ??
      (worldId === 'world-a'
        ? fileURLToPath(new URL('../world-a/public/world-picture.webp', import.meta.url))
        : options.clientRoot
          ? join(options.clientRoot, 'world-picture.svg')
          : undefined);
    if (picturePath)
      app.get('/world-picture', async (_req, reply) => {
        const mime = picturePath.endsWith('.svg')
          ? 'image/svg+xml'
          : picturePath.endsWith('.webp')
            ? 'image/webp'
            : picturePath.endsWith('.jpg') || picturePath.endsWith('.jpeg')
              ? 'image/jpeg'
              : 'image/png';
        return reply
          .type(mime)
          .header('Cache-Control', 'public, max-age=300')
          .send(await readFile(picturePath));
      });
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
