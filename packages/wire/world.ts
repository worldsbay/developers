import { z } from 'zod';
import { PROFILE } from '../core/profile.js';

export const RUNTIME_PROTOCOL = 1;
export const vectorSchema = z
  .object({
    x: z.number().finite().min(-100).max(100),
    y: z.number().finite().min(-20).max(50),
    z: z.number().finite().min(-100).max(100),
  })
  .strict();
export const worldDefinitionSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^[a-z0-9-]+$/),
    title: z.string().min(1).max(80),
    avatarProfile: z.literal(PROFILE),
    protocol: z.literal(RUNTIME_PROTOCOL),
    scene: z.enum(['plaza', 'race', 'starter']),
    roomLimit: z.number().int().min(1).max(32),
    spawn: vectorSchema,
    bounds: z.object({ minX: z.number(), maxX: z.number(), minZ: z.number(), maxZ: z.number() }).strict(),
    collisions: z
      .array(
        z
          .object({
            id: z.string(),
            minX: z.number(),
            maxX: z.number(),
            minZ: z.number(),
            maxZ: z.number(),
            height: z.number().min(0.1).max(10),
          })
          .strict(),
      )
      .max(32),
    portals: z
      .array(z.object({ target: z.string(), position: vectorSchema }).strict())
      .min(1)
      .max(64),
    collection: z.array(z.string().regex(/^[a-z0-9-]+$/)).max(32),
    interactions: z
      .array(
        z
          .object({
            id: z.string().max(60),
            kind: z.enum(['switch', 'race-ready', 'inspect']),
            position: vectorSchema,
            radius: z.number().min(0.5).max(4),
          })
          .strict(),
      )
      .max(16),
  })
  .strict();
export type WorldDefinition = z.infer<typeof worldDefinitionSchema>;
/** Stable registry order lays out each destination once, expanding into garden rings. */
export function hubPortals(targets: string[]): WorldDefinition['portals'] {
  return [...new Set(targets)].slice(0, 64).map((target, index) => {
    if (index === 0) return { target, position: { x: 0, y: 0, z: -7.5 } };
    if (index === 1) return { target, position: { x: -7, y: 0, z: -4 } };
    if (index === 2) return { target, position: { x: 7, y: 0, z: -4 } };
    const ring = Math.floor((index - 3) / 10),
      angle = (((index - 3) % 10) * Math.PI) / 5;
    const radius = 13 + ring * 5;
    return { target, position: { x: Math.sin(angle) * radius, y: 0, z: Math.cos(angle) * radius } };
  });
}
export const defaultDefinition = (id: string, title: string, targets: string[]): WorldDefinition =>
  worldDefinitionSchema.parse({
    version: 1,
    id,
    title,
    avatarProfile: PROFILE,
    protocol: 1,
    scene: id === 'world-b' ? 'race' : id === 'world-a' ? 'plaza' : 'starter',
    roomLimit: 16,
    spawn: { x: 0, y: 0, z: 3 },
    bounds: { minX: -10, maxX: 10, minZ: -10, maxZ: 10 },
    collisions: [
      { id: 'planter', minX: -7.5, maxX: -6.5, minZ: -5.5, maxZ: -4.5, height: 1 },
      ...(id === 'world-b'
        ? []
        : [{ id: 'showroom-door', minX: 2.8, maxX: 3.2, minZ: -1, maxZ: 1, height: 2.2 }]),
    ],
    portals: [...targets.slice(0, 7), ...(id === 'world-a' ? ['random'] : [])].map((target, index) => ({
      target,
      position:
        index === 0
          ? id === 'world-b'
            ? { x: 8, y: 0, z: 4 }
            : { x: 0, y: 0, z: -7.5 }
          : { x: -7 + (index - 1) * 4, y: 0, z: -4 },
    })),
    collection: [],
    interactions: [
      {
        id: id === 'world-b' ? 'race-ready' : 'showroom-switch',
        kind: id === 'world-b' ? 'race-ready' : 'switch',
        position: { x: 1.4, y: 0, z: 3 },
        radius: 2.5,
      },
      { id: 'shop-display', kind: 'inspect', position: { x: -1.4, y: 0, z: 3 }, radius: 2.5 },
    ],
  });
export function publicDefinition(value: WorldDefinition): WorldDefinition {
  return worldDefinitionSchema.parse(value);
}
