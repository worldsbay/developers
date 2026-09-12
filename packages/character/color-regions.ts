import { Color, SRGBColorSpace } from 'three';
import type { CharacterPart } from './contract.js';

// Only authored tops with clearly separated pigment ranges are enabled.
// Unclassified texture pixels retain their original color and baked shading.
export function clothingRegions(part: CharacterPart) {
  if (part.slot !== 'top') return [];
  if (/_Wizard_Body$/.test(part.sourceNode))
    return [
      { id: 'fabric', label: 'Blue fabric', color: '#24334d' },
      { id: 'trim', label: 'Gold trim', color: '#ac7409' },
    ];
  if (/_Ranger_Body$/.test(part.sourceNode))
    return [
      { id: 'fabric', label: 'Green fabric', color: '#355923' },
      { id: 'leather', label: 'Brown leather', color: '#79502c' },
    ];
  return [];
}

export function clothingRegion(part: CharacterPart, color: Color, tint: number) {
  if (tint !== 3 || !clothingRegions(part).length) return undefined;
  const hsl = color.getHSL({ h: 0, s: 0, l: 0 }, SRGBColorSpace);
  const hue = hsl.h * 360;
  if (/_Wizard_Body$/.test(part.sourceNode)) {
    if (hue >= 205 && hue <= 245 && hsl.s > 0.2) return 'fabric';
    if (hue >= 30 && hue <= 55 && hsl.s > 0.55) return 'trim';
  } else {
    if (hue >= 75 && hue <= 150 && hsl.s > 0.2) return 'fabric';
    if (hue >= 15 && hue <= 45 && hsl.s > 0.3) return 'leather';
  }
  return undefined;
}
