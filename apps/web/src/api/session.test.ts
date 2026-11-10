import { describe, expect, it } from 'vitest';
import { SESSION } from '../test/render';
import { isSteppedUp } from './session';

describe('isSteppedUp', () => {
  const now = Date.parse('2026-11-10T12:00:00.000Z');
  it('is false without a session or without a step-up', () => {
    expect(isSteppedUp(null, now)).toBe(false);
    expect(isSteppedUp(undefined, now)).toBe(false);
    expect(isSteppedUp(SESSION, now)).toBe(false);
  });
  it('is true only before the window closes', () => {
    expect(isSteppedUp({ ...SESSION, stepUpExpiresAt: '2026-11-10T12:04:59.000Z' }, now)).toBe(
      true,
    );
    expect(isSteppedUp({ ...SESSION, stepUpExpiresAt: '2026-11-10T12:00:00.000Z' }, now)).toBe(
      false,
    );
    expect(isSteppedUp({ ...SESSION, stepUpExpiresAt: '2026-11-10T11:59:00.000Z' }, now)).toBe(
      false,
    );
  });
});
