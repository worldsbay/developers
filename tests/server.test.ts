import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { WorldsBay, RequestError } from '../packages/sdk/index.js';
import { createWorld, type CentralTransport } from '../apps/world/server.js';
import type { Config } from '../packages/core/config.js';
import type { Appearance, World } from '../packages/core/contract.js';
import { HttpError } from '../packages/core/http.js';
import { PROFILE } from '../packages/core/profile.js';
import { defaultDefinition } from '../packages/wire/world.js';

const world: World = {
  id: 'test-world',
  name: 'Test world',
  description: 'Synthetic test world',
  url: 'https://world.example',
  entryPath: '/enter',
  accent: '#336699',
  definition: defaultDefinition('test-world', 'Test world', ['other-world']),
};
const destination: World = {
  id: 'other-world',
  name: 'Other world',
  description: '',
  url: 'https://other.example',
  entryPath: '/enter',
  accent: '#663399',
};
const privateKey = 'synthetic-private-world-key-do-not-publish';
const now = 2_000_000_000_000;
const expiresAt = now + 3_600_000;
const ticket = 'synthetic-single-use-entry-ticket';
const grant = 'synthetic-server-only-session-grant';
const appearance: Appearance = {
  player: { id: 'test-player', name: 'Test player', color: '#336699' },
  profile: PROFILE,
  bodyAsset: `https://central.example/assets/versions/${'a'.repeat(64)}.glb`,
  animations: ['idle'],
  equipped: [],
};
const cfg: Config = {
  centralUrl: 'https://central.example',
  worlds: [world, destination],
  worldSecrets: { [world.id]: privateKey },
  production: true,
  trustProxy: [],
  assetPath: fileURLToPath(new URL('./fixtures-not-present/', import.meta.url)),
  clientPath: fileURLToPath(new URL('../dist/client/', import.meta.url)),
};
type Call = [string, 'GET' | 'POST', unknown?, string?];
function plannedTransport(steps: { call: Call; result?: unknown; error?: Error }[]) {
  let position = 0;
  const transport: CentralTransport = async <T>(...call: Call) => {
    const step = steps[position++];
    assert.ok(step, `Unexpected central request: ${call[0]}`);
    if (call[0] === '/internal/accept' || call[0] === '/internal/account/logout') {
      assert.match((call[2] as { resumeToken: string }).resumeToken, /^[A-Za-z0-9_-]{43}$/);
      call[2] = undefined; // The random remembered credential is checked above.
    }
    if (call[0] === '/internal/account-context') {
      const handoff = call[2] as { state: string; codeChallenge: string };
      assert.match(handoff.state, /^[A-Za-z0-9_-]{43}$/);
      assert.match(handoff.codeChallenge, /^[A-Za-z0-9_-]{43}$/);
      assert.deepEqual(Object.keys(handoff).sort(), ['codeChallenge', 'state']);
      call[2] = undefined;
    }
    assert.deepEqual(call, step.call);
    if (step.error) throw step.error;
    return step.result as T;
  };
  return { transport, done: () => assert.equal(position, steps.length) };
}
function entrySteps() {
  return [
    {
      call: ['/internal/exchange', 'POST', { token: ticket }] as Call,
      result: { session: grant, expiresAt },
    },
    { call: ['/internal/accept', 'POST', undefined, grant] as Call, result: { ok: true, resumeExpiresAt: expiresAt } },
  ];
}
const browserHeaders = { origin: world.url, 'x-worldsbay': '1' };

test('account menu preserves the player, provides editor return context, and retries failed sign-out', async (t) => {
  const central = plannedTransport([
    ...entrySteps(),
    { call: ['/internal/account', 'GET', undefined, grant], result: { kind: 'account', displayName: appearance.player.name } },
    { call: ['/internal/store', 'POST', {}, grant], result: { url: 'https://central.example/play?context=synthetic-editor-context' } },
    { call: ['/internal/account-context', 'POST', undefined, grant], result: { url: 'https://central.example/auth/world?flow=synthetic' } },
    { call: ['/internal/account/logout', 'POST', undefined, grant], error: new HttpError(503, 'Please retry sign-out.') },
    { call: ['/internal/account', 'GET', undefined, grant], result: { kind: 'account' } },
    { call: ['/internal/account/logout', 'POST', undefined, grant], result: { ok: true } },
  ]);
  const app = await createWorld(cfg, world.id, { static: false, transport: central.transport, now: () => now });
  t.after(() => app.close());
  const entry = await app.inject(`/enter?ticket=${ticket}`);
  const cookie = entry.cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const sdk = new WorldsBay({ fetch: async (url, init) => {
    const response = await app.inject({ method: init?.method as 'GET' | 'POST', url: String(url), headers: { ...Object.fromEntries(new Headers(init?.headers)), cookie, origin: world.url }, ...(init?.body ? { payload: String(init.body) } : {}) });
    return new Response(response.body, { status: response.statusCode });
  } });
  assert.equal((await sdk.readAccount()).kind, 'account');
  const editor = new URL((await sdk.openCharacterCreator()).url);
  assert.equal(editor.searchParams.get('context'), 'synthetic-editor-context');
  assert.equal(editor.searchParams.get('view'), 'character');
  await sdk.createAccountContext();
  assert.equal((await app.inject('/auth/callback?code=' + 'a'.repeat(43) + '&state=' + 'b'.repeat(43))).headers.location, '/?entry=failed');
  await assert.rejects(sdk.signOut(), (error: unknown) => error instanceof RequestError && error.status === 503);
  assert.equal((await sdk.readAccount()).kind, 'account');
  await sdk.signOut();
  await assert.rejects(sdk.readAccount(), (error: unknown) => error instanceof RequestError && error.status === 401);
  central.done();
});

test('published API connects browser and world adapters and preserves central session rejection', async (t) => {
  const central = Fastify();
  const calls: string[] = [];
  let rejectAppearance = false;
  central.all('/internal/:action', async (req, reply) => {
    assert.equal(req.headers.authorization, `Bearer ${privateKey}`);
    assert.equal(req.headers['x-world-id'], world.id);
    assert.equal(req.headers.origin, undefined);
    assert.equal(req.headers['x-world-session'], req.url === '/internal/exchange' ? undefined : grant);
    calls.push(`${req.method} ${req.url}`);
    switch (req.url) {
      case '/internal/exchange':
        assert.deepEqual(req.body, { token: ticket });
        return { session: grant, expiresAt };
      case '/internal/accept':
        assert.match((req.body as { resumeToken: string }).resumeToken, /^[A-Za-z0-9_-]{43}$/);
        return { ok: true, resumeExpiresAt: expiresAt };
      case '/internal/store':
        assert.deepEqual(req.body, { selectedItem: 'test-hat' });
        return { url: 'https://central.example/store' };
      case '/internal/appearance':
        if (rejectAppearance) return reply.code(401).send({ error: 'Session revoked.' });
        return { ...appearance, bodyAsset: `${centralUrl}/assets/versions/${'a'.repeat(64)}.glb` };
      default:
        throw new Error(`Unexpected central request: ${req.url}`);
    }
  });
  const centralUrl = await central.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => central.close());
  const app = await createWorld({ ...cfg, centralUrl }, world.id, { static: false, now: () => now });
  t.after(() => app.close());
  const entry = await app.inject(`/enter?ticket=${ticket}`);
  assert.equal(entry.headers.location, '/');
  assert.ok(entry.headers['set-cookie']);
  const cookie = entry.cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const sdk = new WorldsBay({
    fetch: async (url, init) => {
      const headers = Object.fromEntries(new Headers(init?.headers));
      const response = await app.inject({
        method: init?.method as 'GET' | 'POST',
        url: String(url),
        headers: { ...headers, cookie, origin: world.url },
        ...(init?.body ? { payload: String(init.body) } : {}),
      });
      for (const secret of [ticket, grant, privateKey]) assert.ok(!response.body.includes(secret));
      return new Response(response.body, { status: response.statusCode });
    },
  });
  assert.equal((await sdk.getConfig()).world.id, world.id);
  assert.equal((await sdk.openWardrobe('test-hat')).url, 'https://central.example/store');
  assert.equal((await sdk.readAppearance()).player.id, appearance.player.id);
  rejectAppearance = true;
  await assert.rejects(sdk.refreshAppearance(), (error: unknown) => {
    assert.ok(error instanceof RequestError);
    assert.equal(error.status, 401);
    return true;
  });
  assert.deepEqual(calls, [
    'POST /internal/exchange',
    'POST /internal/accept',
    'POST /internal/store',
    'GET /internal/appearance',
    'GET /internal/appearance',
  ]);
});

test('public config and built browser files work without exposing server files or credentials', async (t) => {
  const central = plannedTransport([]);
  const app = await createWorld(cfg, world.id, {
    transport: central.transport,
    now: () => now,
    clientRoot: fileURLToPath(new URL('../public/', import.meta.url)),
  });
  t.after(() => app.close());
  assert.deepEqual((await app.inject('/health')).json(), { ok: true, service: world.id });
  const config = await app.inject('/api/config');
  assert.equal(config.statusCode, 200);
  assert.equal(config.json().world.id, world.id);
  assert.equal(config.json().homeUrl, cfg.centralUrl);
  assert.ok(!config.body.includes(privateKey));
  assert.deepEqual(Object.keys(config.json()).sort(), ['homeUrl', 'world']);
  for (const url of [
    '/',
    '/client/runtime/sdk.js',
    '/client/runtime/three.js',
    '/client/runtime/character.js',
  ]) {
    const response = await app.inject(url);
    assert.equal(response.statusCode, 200, url);
    assert.ok(response.body.length > 0, url);
    assert.ok(!response.body.includes(privateKey), url);
    if (url !== '/') assert.match(String(response.headers['content-type']), /javascript/);
  }
  for (const url of [
    '/.env',
    '/server.mjs',
    '/package.json',
    '/world-content/.env',
    '/world-content/server.mjs',
  ]) {
    assert.equal((await app.inject(url)).statusCode, 404, url);
  }
  central.done();
});

test('failed entry acceptance issues no authorizing browser cookie or usable local session', async (t) => {
  const steps = entrySteps();
  const central = plannedTransport([
    steps[0],
    { call: steps[1].call, error: new HttpError(503, 'Synthetic accept failure') },
  ]);
  const app = await createWorld(cfg, world.id, {
    static: false,
    transport: central.transport,
    now: () => now,
  });
  t.after(() => app.close());
  const response = await app.inject(`/enter?ticket=${ticket}`);
  assert.equal(response.statusCode, 302);
  assert.equal(response.headers.location, '/?entry=failed');
  assert.ok(!response.cookies.some(c => c.name === '__Host-pb_test-world'));
  assert.equal((await app.inject('/api/session')).statusCode, 401);
  central.done();
});

test('accepted entry keeps grants on the server and protects browser actions with a cookie and matching origin', async (t) => {
  const central = plannedTransport([
    ...entrySteps(),
    { call: ['/internal/worlds', 'GET'], result: [world, destination] },
    { call: ['/internal/appearance', 'GET', undefined, grant], result: appearance },
    {
      call: ['/internal/store', 'POST', { selectedItem: 'test-hat' }, grant],
      result: { url: 'https://central.example/store' },
    },
    {
      call: ['/internal/travel', 'POST', { worldId: destination.id }, grant],
      result: { url: `${destination.url}/enter?ticket=next-ticket` },
    },
  ]);
  const app = await createWorld(cfg, world.id, {
    static: false,
    transport: central.transport,
    now: () => now,
    probe: async (url) => {
      assert.equal(url, destination.url);
      return true;
    },
  });
  t.after(() => app.close());
  for (const url of ['/api/session', '/api/appearance', '/api/collection', '/api/room-metrics']) {
    assert.equal((await app.inject(url)).statusCode, 401, url);
  }
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/store', headers: browserHeaders, payload: {} }))
      .statusCode,
    401,
  );
  const entry = await app.inject(`/enter?ticket=${ticket}`);
  assert.equal(entry.statusCode, 302);
  assert.equal(entry.headers.location, '/');
  const setCookie = (entry.headers['set-cookie'] as string[]).find(value => value.startsWith('__Host-pb_test-world='))!;
  assert.match(setCookie, /^__Host-pb_test-world=/);
  for (const attribute of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax'])
    assert.ok(setCookie.includes(attribute));
  for (const secret of [ticket, grant, privateKey]) assert.ok(!setCookie.includes(secret));
  const cookie = entry.cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const session = await app.inject({ url: '/api/session', headers: { cookie } });
  assert.equal(session.statusCode, 200);
  assert.equal(session.json().appearance.player.id, appearance.player.id);
  assert.equal(session.json().appearance.bodyAsset, `${world.url}/avatar-assets/${'a'.repeat(64)}.glb`);
  assert.equal(session.json().expiresAt, expiresAt);
  for (const secret of [ticket, grant, privateKey]) assert.ok(!session.body.includes(secret));
  for (const headers of [
    { ...browserHeaders, origin: 'https://unrelated.example', cookie },
    { origin: world.url, cookie },
    { ...browserHeaders, authorization: 'Bearer synthetic-token', cookie },
  ]) {
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/store', headers, payload: {} })).statusCode,
      403,
    );
  }
  const store = await app.inject({
    method: 'POST',
    url: '/api/store',
    headers: { ...browserHeaders, cookie },
    payload: { selectedItem: 'test-hat' },
  });
  assert.equal(store.statusCode, 200);
  assert.equal(store.json().url, 'https://central.example/store');
  const travel = await app.inject({
    method: 'POST',
    url: '/api/travel',
    headers: { ...browserHeaders, cookie },
    payload: { worldId: destination.id },
  });
  assert.equal(travel.statusCode, 200);
  assert.ok(travel.json().url.startsWith(destination.url));
  central.done();
});
