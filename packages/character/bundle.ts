import type { CharacterPack } from './contract.js';

/** Point a bundled manifest at locally served files without changing its authority revision. */
export function resolveCharacterPack(pack: CharacterPack, assetBaseUrl: string | URL): CharacterPack {
  const result = structuredClone(pack),
    base = String(assetBaseUrl);
  const assets = [
    ...result.parts.flatMap((p) => [p.asset, ...(p.thumbnail ? [p.thumbnail] : [])]),
    ...result.rigs.flatMap((r) => [r.asset, r.defaultAnimations, ...r.clips.map((c) => c.asset)]),
  ];
  for (const asset of assets) asset.url = new URL(asset.file, base.endsWith('/') ? base : base + '/').href;
  return result;
}
