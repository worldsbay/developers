import { z } from 'zod';

export const CHARACTER_PROFILE = 'pocket-humanoid-v2' as const;
export const characterSlots = [
  'head',
  'hair',
  'beard',
  'headwear',
  'top',
  'outerwear',
  'arms',
  'armwear',
  'legs',
  'feet',
  'belt',
  'shoulders',
  'neck',
  'back',
  'weapon',
] as const;
export type CharacterSlot = (typeof characterSlots)[number];
export const characterLimits = {
  triangles: 40000,
  joints: 64,
  influences: 4,
  drawCalls: 1,
  materials: 1,
} as const;
const id = z
  .string()
  .regex(/^[a-z0-9-]+$/)
  .max(120);
const color = z.string().regex(/^#[a-f0-9]{6}$/i);
const colorMode = z.enum(['original', 'custom']);
export const characterRecipeSchema = z
  .object({
    version: z.literal(1),
    packRevision: z.string().regex(/^[a-f0-9]{64}$/),
    rig: id,
    parts: z
      .object(
        Object.fromEntries(characterSlots.map((slot) => [slot, id.nullable().optional()])) as Record<
          CharacterSlot,
          z.ZodOptional<z.ZodNullable<typeof id>>
        >,
      )
      .strict(),
    colors: z.object({ skin: color, hair: color, cloth: color }).strict(),
    colorMode: colorMode.optional(),
    partColors: z
      .record(
        id,
        z.object({ fabric: color.optional(), trim: color.optional(), leather: color.optional() }).strict(),
      )
      .refine((parts) => Object.keys(parts).length <= 128)
      .optional(),
    partColorModes: z
      .object(
        Object.fromEntries(characterSlots.map((slot) => [slot, colorMode.optional()])) as Record<
          CharacterSlot,
          z.ZodOptional<typeof colorMode>
        >,
      )
      .strict()
      .optional(),
  })
  .strict();
export type CharacterRecipe = z.infer<typeof characterRecipeSchema>;
export type CharacterAsset = { file: string; sha256: string; bytes: number; url?: string };
export type CharacterPart = {
  id: string;
  name: string;
  rig: string;
  slot: CharacterSlot;
  family: string;
  source: string;
  sourceNode: string;
  triangles: number;
  asset: CharacterAsset;
  thumbnail?: CharacterAsset;
  collection?: string;
  adaptedFrom?: string;
  requires?: string[];
  requiredSlots?: CharacterSlot[];
  compatibleWith?: Partial<Record<CharacterSlot, string[]>>;
  hides?: CharacterSlot[];
};
export type CharacterClip = {
  id: string;
  name: string;
  library: string;
  sourceName: string;
  duration: number;
  loop: boolean;
  rootMotion: 'in-place';
  asset: CharacterAsset;
};
export type CharacterRig = {
  colorChannels?: ('skin' | 'hair' | 'cloth')[];
  id: string;
  name: string;
  asset: CharacterAsset;
  joints: number;
  requiredSlots: CharacterSlot[];
  defaults: Partial<Record<CharacterSlot, string>>;
  defaultAnimations: CharacterAsset;
  aliases: Record<string, string>;
  clips: CharacterClip[];
};
export type CharacterPack = {
  /** Game-only packs must never be included in standalone asset downloads. */
  distribution?: 'game-only';
  version: 1;
  profile: typeof CHARACTER_PROFILE;
  revision: string;
  rigs: CharacterRig[];
  parts: CharacterPart[];
  repairs?: string[];
};
export type CharacterAppearance = {
  recipe: CharacterRecipe;
  rig: CharacterAsset;
  defaultAnimations: CharacterAsset;
  parts: CharacterPart[];
};

/** Validate IDs and compatibility against the authority's immutable pack. No caller URLs. */
export function validateCharacterRecipe(input: unknown, pack: CharacterPack): CharacterRecipe {
  const recipe = characterRecipeSchema.parse(input);
  if (recipe.packRevision !== pack.revision) throw new Error('Character pack changed. Reload the builder.');
  const rig = pack.rigs.find((r) => r.id === recipe.rig);
  if (!rig) throw new Error('Unknown character rig.');
  let triangles = 0;
  const selected = Object.values(recipe.parts).filter(Boolean);
  for (const slot of characterSlots) {
    const partId = recipe.parts[slot];
    if (!partId) {
      if (characterRequiredSlots(recipe, pack).includes(slot)) throw new Error(`Choose a ${slot} part.`);
      continue;
    }
    const part = pack.parts.find((p) => p.id === partId);
    if (!part || part.rig !== recipe.rig || part.slot !== slot) throw new Error(`Incompatible ${slot} part.`);
    if (part.requires?.length && !part.requires.some((p) => selected.includes(p)))
      throw new Error(`${part.name} needs its matching base part.`);
    const issue = characterPartIssue(part, recipe, pack);
    if (issue) throw new Error(issue);
    triangles += part.triangles;
  }
  if (triangles > characterLimits.triangles)
    throw new Error('This outfit exceeds the character geometry budget.');
  return recipe;
}

export function defaultCharacterRecipe(pack: CharacterPack, rigId = pack.rigs[0].id): CharacterRecipe {
  const rig = pack.rigs.find((r) => r.id === rigId);
  if (!rig) throw new Error('Unknown character rig.');
  return {
    version: 1,
    packRevision: pack.revision,
    rig: rig.id,
    parts: { ...rig.defaults },
    colors: { skin: '#c99069', hair: '#44302b', cloth: '#719b81' },
    colorMode: 'original',
  };
}

export function characterAppearance(recipe: CharacterRecipe, pack: CharacterPack): CharacterAppearance {
  validateCharacterRecipe(recipe, pack);
  const rig = pack.rigs.find((r) => r.id === recipe.rig)!;
  const hidden = characterHiddenSlots(recipe, pack);
  return {
    recipe,
    rig: rig.asset,
    defaultAnimations: rig.defaultAnimations,
    parts: characterSlots.flatMap((slot) =>
      recipe.parts[slot] && !hidden.has(slot) ? [pack.parts.find((p) => p.id === recipe.parts[slot])!] : [],
    ),
  };
}

export function characterPartIssue(
  part: CharacterPart,
  recipe: CharacterRecipe,
  pack: CharacterPack,
): string | null {
  for (const [slot, allowed] of Object.entries(part.compatibleWith ?? {})) {
    if (!allowed.includes(recipe.parts[slot as CharacterSlot] ?? '')) {
      const names = allowed.map((id) => pack.parts.find((p) => p.id === id)?.name ?? id);
      return `${part.name} fits ${names.join(' or ')}.`;
    }
  }
  return null;
}

export function characterHiddenSlots(recipe: CharacterRecipe, pack: CharacterPack) {
  const hidden = new Map<CharacterSlot, string>();
  for (const part of pack.parts.filter((p) => Object.values(recipe.parts).includes(p.id)))
    for (const slot of part.hides ?? []) hidden.set(slot, part.name);
  return hidden;
}

export function characterRequiredSlots(recipe: CharacterRecipe, pack: CharacterPack) {
  return [
    ...new Set([
      ...pack.rigs.find((r) => r.id === recipe.rig)!.requiredSlots,
      ...pack.parts
        .filter((p) => Object.values(recipe.parts).includes(p.id))
        .flatMap((p) => p.requiredSlots ?? []),
    ]),
  ];
}

/** Open a pinned recipe against the current catalogue without discarding its outfit. */
export function restoreCharacterRecipe(recipe: CharacterRecipe, pack: CharacterPack) {
  const result = structuredClone(recipe);
  const replaced: CharacterSlot[] = [];
  const rig = pack.rigs.find((r) => r.id === result.rig);
  if (!rig) throw new Error('Unknown character rig.');
  if (result.packRevision !== pack.revision) {
    for (const slot of characterSlots) {
      const id = result.parts[slot];
      if (id && !pack.parts.some((p) => p.id === id && p.rig === rig.id && p.slot === slot)) {
        result.parts[slot] = rig.defaults[slot] ?? null;
        replaced.push(slot);
      }
    }
    result.packRevision = pack.revision;
  }
  return { ...reconcileCharacterParts(result, pack), replaced };
}

/** Keep required parts complete and remove optional pieces that no longer fit. */
export function reconcileCharacterParts(recipe: CharacterRecipe, pack: CharacterPack) {
  const result = structuredClone(recipe),
    removed: string[] = [],
    fitted: string[] = [];
  const rig = pack.rigs.find((r) => r.id === result.rig)!;
  for (const slot of characterRequiredSlots(result, pack)) {
    if (result.parts[slot]) continue;
    const family = pack.parts.find((p) => p.id === result.parts.top)?.family;
    const candidates = pack.parts.filter(
      (p) => p.rig === rig.id && p.slot === slot && !characterPartIssue(p, result, pack),
    );
    const replacement = candidates.find((p) => p.family === family) ?? candidates[0];
    if (!replacement) throw new Error(`No compatible ${slot} part.`);
    result.parts[slot] = replacement.id;
    fitted.push(replacement.name);
  }
  for (const slot of characterSlots) {
    const part = pack.parts.find((p) => p.id === result.parts[slot]);
    if (part && characterPartIssue(part, result, pack)) {
      if (characterRequiredSlots(result, pack).includes(slot)) {
        const replacement = pack.parts.find(
          (candidate) =>
            candidate.rig === rig.id &&
            candidate.slot === slot &&
            !characterPartIssue(candidate, result, pack),
        );
        if (!replacement) throw new Error(`No compatible ${slot} part.`);
        result.parts[slot] = replacement.id;
        fitted.push(replacement.name);
      } else {
        result.parts[slot] = null;
        removed.push(part.name);
      }
    }
  }
  return { recipe: validateCharacterRecipe(result, pack), removed, fitted };
}
