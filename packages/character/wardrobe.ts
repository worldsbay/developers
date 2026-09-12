import {
  characterSlots,
  defaultCharacterRecipe,
  reconcileCharacterParts,
  type CharacterPack,
  type CharacterRecipe,
  type CharacterSlot,
} from './contract.js';

// Presentation groups keep source rigs out of the character creation flow.
const groups: Record<string, { character: string; style: string }> = {
  'modular-men': { character: 'Male', style: 'Everyday' },
  'modular-women': { character: 'Female', style: 'Everyday' },
  'fantasy-male': { character: 'Male', style: 'Fantasy' },
  'fantasy-female': { character: 'Female', style: 'Fantasy' },
  'universal-male': { character: 'Male', style: 'Base' },
  'universal-female': { character: 'Female', style: 'Base' },
  'bestiary-imp': { character: 'Imp', style: 'Fantasy' },
  'bestiary-puglin': { character: 'Puglin', style: 'Fantasy' },
};

/** Temporarily hide duplicate dark-skin entries; retain assets for existing saves. */
export function selectableCharacterParts(pack: CharacterPack, rig: string, slot: CharacterSlot) {
  return pack.parts.filter(
    (part) =>
      part.rig === rig &&
      part.slot === slot &&
      !(
        rig.startsWith('universal-') &&
        /-dark(?:-body)?$/.test(part.id) &&
        pack.parts.some((other) => other.id === part.id.replace(/-dark(?=-body$|$)/, '-light'))
      ),
  );
}

export function wardrobeChoices(pack: CharacterPack) {
  return pack.rigs.map((rig) => ({
    rig: rig.id,
    ...(groups[rig.id] ?? { character: rig.name, style: 'Everyday' }),
  }));
}

/** Keep the same authored face and hair while changing the clothing rig. */
export function changeClothingStyle(recipe: CharacterRecipe, pack: CharacterPack, rigId: string) {
  const next = defaultCharacterRecipe(pack, rigId);
  next.colors = { ...recipe.colors };
  next.colorMode = recipe.colorMode;
  next.partColorModes = { ...recipe.partColorModes };
  const choices = wardrobeChoices(pack);
  const sameCharacter =
    choices.find((c) => c.rig === recipe.rig)?.character === choices.find((c) => c.rig === rigId)?.character;
  const unavailable: string[] = [];
  if (sameCharacter) {
    for (const slot of ['head', 'hair'] as const) {
      const id = recipe.parts[slot];
      if (!id) {
        if (slot === 'hair') next.parts.hair = null;
        continue;
      }
      const original = pack.parts.find((part) => part.id === id)!;
      const matching = pack.parts.find(
        (part) =>
          part.rig === rigId &&
          part.slot === slot &&
          part.collection === original.collection &&
          part.name === original.name,
      );
      if (matching) next.parts[slot] = matching.id;
      else unavailable.push(original.name);
    }
  }
  return { ...reconcileCharacterParts(next, pack), unavailable };
}

/** An outfit supplies the required clothing pieces; identity remains independent. */
export function wardrobeOutfits(pack: CharacterPack, rigId: string) {
  const rig = pack.rigs.find((r) => r.id === rigId)!;
  const clothingSlots = rig.requiredSlots.filter((slot) => slot !== 'head' && slot !== 'hair');
  const families = [
    ...new Set(pack.parts.filter((p) => p.rig === rigId && p.slot === 'top').map((p) => p.family)),
  ];
  return families.flatMap((family) => {
    const parts: CharacterRecipe['parts'] = {};
    if (rigId.startsWith('universal-')) {
      const candidates = pack.parts.filter((p) => p.rig === rigId && p.family === family);
      const top =
        candidates.find((p) => p.slot === 'top' && p.requiredSlots?.length) ??
        candidates.find((p) => p.slot === 'top')!;
      parts.top = top.id;
      for (const slot of top.requiredSlots ?? []) parts[slot] = candidates.find((p) => p.slot === slot)!.id;
      for (const slot of ['outerwear', 'armwear'] as const) {
        const accessory = candidates.find((p) => p.slot === slot);
        if (accessory) parts[slot] = accessory.id;
      }
      return [{ family, parts }];
    }
    for (const slot of clothingSlots) {
      const part = pack.parts.find(
        (p) => p.rig === rigId && p.slot === slot && p.family === family && !p.adaptedFrom,
      );
      if (!part) return [];
      parts[slot] = part.id;
    }
    return [{ family, parts }];
  });
}

export function chooseOutfit(recipe: CharacterRecipe, pack: CharacterPack, family: string) {
  const outfit = wardrobeOutfits(pack, recipe.rig).find((o) => o.family === family);
  if (!outfit) throw new Error('Unknown outfit.');
  const next = structuredClone(recipe);
  for (const slot of characterSlots)
    if (slot !== 'head' && slot !== 'hair' && slot !== 'beard') next.parts[slot] = outfit.parts[slot] ?? null;
  if (recipe.rig.startsWith('universal-') && /-dark(?:-body)?$/.test(recipe.parts.top ?? '')) {
    const dark = pack.parts.find(
      (p) =>
        p.rig === recipe.rig &&
        p.family === family &&
        p.slot === 'top' &&
        (family === 'Superhero' ? p.id.endsWith('-dark-body') : p.id.endsWith('-dark')),
    );
    if (dark) next.parts.top = dark.id;
  }
  return reconcileCharacterParts(next, pack).recipe;
}

export function selectedOutfit(recipe: CharacterRecipe, pack: CharacterPack) {
  if (recipe.rig.startsWith('universal-')) {
    const top = pack.parts.find((p) => p.id === recipe.parts.top);
    if (!top?.requiredSlots?.length) return top?.family ?? '';
    const outfit = wardrobeOutfits(pack, recipe.rig).find((o) => o.family === top.family);
    return outfit &&
      Object.entries(outfit.parts).every(
        ([slot, id]) => slot === 'top' || recipe.parts[slot as keyof typeof recipe.parts] === id,
      )
      ? top.family
      : '';
  }
  return (
    wardrobeOutfits(pack, recipe.rig).find((o) =>
      Object.entries(o.parts).every(([slot, id]) => recipe.parts[slot as keyof typeof recipe.parts] === id),
    )?.family ?? ''
  );
}

export const characterPartLabel = (name: string) => name.replace(/\bSuperhero\b/g, 'Base');

export const outfitLabel = (family: string) =>
  characterPartLabel(family)
    .replace(/([a-z])([A-Z0-9])/g, '$1 $2')
    .replace('Sci Fi', 'Sci-Fi')
    .replace('Swat', 'SWAT');
