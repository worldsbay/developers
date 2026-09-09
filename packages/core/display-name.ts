import { z } from 'zod';

export const displayNameHint =
  'Use 2–24 characters: letters, numbers, spaces, dots, hyphens, underscores, or apostrophes.';
export const displayNameSchema = z
  .string()
  .max(80, displayNameHint)
  .transform((name) => name.normalize('NFKC').trim().replace(/ +/g, ' '))
  .pipe(
    z
      .string()
      .min(2, displayNameHint)
      .max(24, displayNameHint)
      .regex(/^[\p{L}\p{M}\p{N} ._'’\-]+$/u, displayNameHint)
      .regex(/[\p{L}\p{N}]/u, displayNameHint),
  );
