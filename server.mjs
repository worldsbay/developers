import 'dotenv/config';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { createWorld } from './apps/world/server.ts';
import { publicWorldSchema } from './packages/core/registry.ts';
import { defaultDefinition } from './packages/wire/world.ts';

for (const name of ['WORLD_ID', 'WORLD_URL', 'WORLD_SECRET']) {
  if (!process.env[name] || process.env[name].startsWith('replace-'))
    throw new Error(`Set ${name} in .env using the configuration from https://worldsbay.com/connect.`);
}
const centralUrl = new URL(process.env.CENTRAL_URL || 'https://worldsbay.com').origin;
const worldUrl = new URL(process.env.WORLD_URL).origin;
if (
  !centralUrl.startsWith('https:') ||
  !worldUrl.startsWith('https:') ||
  new URL(centralUrl).hostname === new URL(worldUrl).hostname
)
  throw new Error('WorldsBay and your world need separate HTTPS hostnames.');
if (process.env.WORLD_SECRET.length < 32)
  throw new Error('Use the full private world key from registration.');
const worldId = process.env.WORLD_ID;
const definition = defaultDefinition(worldId, process.env.WORLD_NAME || 'My World', [
  'world-a',
  'random',
]);
definition.scene = 'starter';
const world = publicWorldSchema.parse({
  id: worldId,
  name: definition.title,
  description: 'A multiplayer world connected to WorldsBay.',
  url: worldUrl,
  entryPath: '/enter',
  accent: '#67dfd0',
  definition,
});
const port = Number(process.env.PORT || 3003);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
const clientPath = resolve('dist/client');
if (!existsSync(resolve(clientPath, 'runtime/three.js')))
  throw new Error('Run npm run build before starting your world.');
const verification = existsSync('worldsbay.json')
  ? JSON.parse(readFileSync('worldsbay.json', 'utf8'))
  : undefined;
const host = process.env.BIND_HOST || '127.0.0.1';
const app = await createWorld(
  {
    centralUrl,
    worlds: [world],
    production: true,
    trustProxy: ['127.0.0.1', '::1'],
    worldSecrets: { [worldId]: process.env.WORLD_SECRET },
    assetPath: resolve('assets'),
    clientPath,
  },
  worldId,
  { logger: true, clientRoot: resolve('public'), verification },
);
await app.listen({ host, port });
console.log(`World listening on ${host}:${port}`);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => void app.close().then(() => process.exit(0)));
