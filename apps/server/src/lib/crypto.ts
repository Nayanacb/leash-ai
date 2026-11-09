import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** 256 bits of randomness, URL-safe. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function hmacBase64Url(key: string, message: string): string {
  return createHmac('sha256', key).update(message, 'utf8').digest('base64url');
}

/** Constant-time string comparison (for values of equal, public length). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
