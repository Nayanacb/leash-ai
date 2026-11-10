import argon2 from 'argon2';

/** OWASP-recommended Argon2id parameters (19 MiB, 2 iterations, 1 lane). */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Runs a real verification against a throwaway hash so that a login for an
 * unknown email takes as long as one for a known email (no user enumeration
 * through timing). Always resolves to false.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword('leash-timing-equalizer');
  await verifyPassword(await dummyHash, password);
  return false;
}
