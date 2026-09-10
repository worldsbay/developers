import { z } from 'zod';

export const WORLD_TAG_SUGGESTIONS = [
  'racing',
  'social',
  'adventure',
  'roleplay',
  'puzzles',
  'exploration',
  'arcade',
  'platformer',
  'building',
  'sandbox',
  'survival',
  'sports',
  'music',
  'art',
  'education',
  'relaxing',
  'fantasy',
  'sci-fi',
  'co-op',
  'competitive',
] as const;

const slug = (max: number) =>
  z
    .string()
    .trim()
    .toLowerCase()
    .transform((value) => value.replace(/\s+/g, '-'))
    .pipe(
      z
        .string()
        .min(1)
        .max(max)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use letters, numbers, spaces or single hyphens.'),
    );

export const worldTagSchema = slug(32);
export const worldTagsSchema = z
  .array(worldTagSchema)
  .max(12)
  .transform((tags) => [...new Set(tags)]);
export const worldGroupSchema = slug(60);
export const worldMetadataSchema = z
  .object({
    tags: worldTagsSchema.optional(),
    group: worldGroupSchema.optional(),
  })
  .strict();

// Keep string targets compatible with the SDK's requestTravel(worldId) API.
export const portalTargetSchema = z
  .string()
  .regex(
    /^(?:[a-z0-9-]{3,60}|group:[a-z0-9]+(?:-[a-z0-9]+)*)$/,
    'Use a world ID, random, or group:<group-name>.',
  )
  .max(66);

export function portalGroup(target: string): string | undefined {
  return target.startsWith('group:') ? target.slice(6) : undefined;
}

export function portalMatchesWorld(target: string, world: { id: string; group?: string }) {
  return (
    target === world.id ||
    target === 'random' ||
    (portalGroup(target) !== undefined && portalGroup(target) === world.group)
  );
}
