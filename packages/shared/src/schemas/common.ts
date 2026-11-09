import { z } from 'zod';

export const IdParamSchema = z.object({ id: z.uuid() });

// Matching control characters is the point of this pattern (tab, LF and CR are allowed).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** Rejects strings containing control characters (other than tab/newline) — a cheap guard against log and UI spoofing. */
export function plainText(min: number, max: number) {
  return z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((v) => !CONTROL_CHARACTERS.test(v), 'must not contain control characters');
}

export const IsoDateTimeSchema = z.iso.datetime({ offset: true });
