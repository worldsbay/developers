import { z } from 'zod';

import { PROFILE } from './profile.js';
import type { WorldDefinition } from '../wire/world.js';
import type { CharacterAppearance, CHARACTER_PROFILE } from '../character/contract.js';
export { PROFILE } from './profile.js';
export const slotSchema = z.enum(['head', 'face', 'back', 'upper-body']);
export const itemSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string().min(1).max(80),
    description: z.string().max(300),
    slot: slotSchema,
    // Read old immutable item manifests without exposing their retired price field.
    priceXno: z.number().optional(),
    asset: z.string().regex(/^[a-z0-9-]+\.(gltf|glb)$/),
    version: z.string().min(1),
    profile: z.literal(PROFILE),
    attachment: z.enum(['Head', 'Spine']),
    creator: z.string().min(1).max(100),
    license: z.enum(['CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'MIT', 'LicenseRef-Permission']),
    permission: z.string().min(1).max(500),
    color: z.string().regex(/^#[0-9a-f]{6}$/i),
    kind: z.enum(['rigid', 'skinned']).optional(),
    rigRevision: z.literal('humanoid-1').optional(),
    coverage: z.array(z.literal('torso')).max(1).optional(),
    sourceFiles: z.array(z.string().min(1).max(200)).max(20).optional(),
    assetRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    validation: z.enum(['legacy-approved', 'validated']).optional(),
    listed: z.boolean().optional(),
    assetUrl: z.string().url().optional(),
  })
  .strict()
  .transform(({ priceXno: _legacyPrice, ...item }) => item);
export type Item = z.infer<typeof itemSchema>;
export type World = {
  id: string;
  name: string;
  description: string;
  url: string;
  entryPath: string;
  accent: string;
  thumbnail?: string;
  tags?: string[];
  group?: string;
  definition?: WorldDefinition;
};
export type Player = { id: string; name: string; color: string };
export type Appearance = {
  player: Player;
  revision?: number;
  profile: typeof PROFILE | typeof CHARACTER_PROFILE;
  bodyAsset: string;
  baseAssetRevision?: string;
  rigRevision?: 'humanoid-1' | string;
  character?: CharacterAppearance;
  animations: ('idle' | 'walk' | 'run' | 'jump' | 'fall' | 'land' | 'wave' | 'dance')[];
  animationRefs?: { id: string; assetRevision: string; clip: string }[];
  equipped: (Item & { assetUrl: string })[];
};
export type Wardrobe = {
  appearance: Appearance;
  inventory: string[];
  catalogue: Item[];
  ownedItems?: (Item & { assetUrl: string })[];
};
export type WorldSession = {
  world: World;
  appearance: Appearance;
  destinations: World[];
  homeUrl: string;
  expiresAt?: number;
};
export type WorldAccount = {
  kind: 'guest' | 'account';
  username?: string;
  provider?: 'local' | 'supabase';
  confirmationPending?: boolean;
  displayName?: string;
};
export type TravelEvent = {
  id: string;
  player_id: string;
  source: string;
  destination: string;
  completed_at: number;
};
