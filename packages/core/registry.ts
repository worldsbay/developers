import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { worldDefinitionSchema } from '../wire/world.js';

export function origin(value: string) {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('Public URLs must be HTTP(S) origins without paths or credentials.');
  return url.origin;
}
export const publicWorldSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{3,60}$/),
    name: z.string().min(1).max(80),
    description: z.string().max(300),
    url: z.string().transform(origin),
    entryPath: z.literal('/enter'),
    accent: z.string().regex(/^#[0-9a-f]{6}$/i),
    definition: worldDefinitionSchema.optional(),
  })
  .strict()
  .superRefine((world, context) => {
    if (world.definition && world.definition.id !== world.id)
      context.addIssue({ code: 'custom', message: 'World and definition IDs must match.' });
  });
export const registrySchema = z
  .object({ version: z.literal(1), worlds: z.array(publicWorldSchema).max(30) })
  .strict();
export const keyFileSchema = z
  .object({
    version: z.literal(1),
    keys: z.record(z.string().regex(/^[a-z0-9-]{3,60}$/), z.string().min(32).max(200)),
  })
  .strict();
export function registryPaths(env: NodeJS.ProcessEnv = process.env) {
  return {
    registry: resolve(env.WORLD_REGISTRY_PATH ?? 'data/worlds.json'),
    keys: resolve(env.WORLD_KEYS_PATH ?? 'data/world-keys.json'),
  };
}
export function readRegistry(env: NodeJS.ProcessEnv = process.env) {
  const paths = registryPaths(env);
  return {
    worlds: existsSync(paths.registry)
      ? registrySchema.parse(JSON.parse(readFileSync(paths.registry, 'utf8'))).worlds
      : [],
    keys: existsSync(paths.keys)
      ? keyFileSchema.parse(JSON.parse(readFileSync(paths.keys, 'utf8'))).keys
      : {},
  };
}
export function validateWorldOrigins(
  centralUrl: string,
  worlds: { id: string; url: string; definition?: { portals: { target: string }[] } }[],
) {
  if (new Set(worlds.map((w) => w.id)).size !== worlds.length) throw new Error('World IDs must be unique.');
  if (new Set([centralUrl, ...worlds.map((w) => w.url)]).size !== worlds.length + 1)
    throw new Error('Central and worlds need distinct origins.');
  if (
    new Set([centralUrl, ...worlds.map((w) => w.url)].map((url) => new URL(url).hostname)).size !==
    worlds.length + 1
  )
    throw new Error('Every service needs a different hostname/IP: cookies are not isolated by port.');
  for (const world of worlds)
    for (const portal of world.definition?.portals ?? [])
      if (
        portal.target !== 'random' &&
        (portal.target === world.id || !worlds.some((w) => w.id === portal.target))
      )
        throw new Error('Portals must target another registered world.');
}
