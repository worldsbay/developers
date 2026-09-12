import { z } from 'zod';
export const avatarStyleSchema = z.enum(['low-poly', 'detailed']);
export type AvatarStyle = z.infer<typeof avatarStyleSchema>;
export const avatarSupportSchema = z
  .array(avatarStyleSchema)
  .max(2)
  .refine((v) => new Set(v).size === v.length, 'Choose each style once.');
export function characterStyle(rig: string): AvatarStyle {
  return /^(universal-|bestiary-)/.test(rig) ? 'detailed' : 'low-poly';
}
export function avatarSupportLabel(support?: AvatarStyle[]) {
  if (!support) return 'Avatar support not specified';
  if (!support.length) return 'World-provided avatars';
  return support.length === 2
    ? 'Low-poly & detailed avatars'
    : support[0] === 'detailed'
      ? 'Detailed avatars'
      : 'Low-poly avatars';
}
