import { z } from 'zod';

export const EmailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));

/**
 * Password policy: length is what matters (NIST SP 800-63B). The upper bound
 * prevents hashing multi-megabyte inputs.
 */
export const PasswordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(256, 'Password must be at most 256 characters');

export const RegisterInputSchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
});
export type RegisterInput = z.infer<typeof RegisterInputSchema>;

/** Login does not re-validate the password policy, so it reveals nothing about it. */
export const LoginInputSchema = z.object({
  email: z.string().trim().toLowerCase().min(1).max(254),
  password: z.string().min(1).max(256),
});
export type LoginInput = z.infer<typeof LoginInputSchema>;

export const UserDtoSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  createdAt: z.string(),
});
export type UserDto = z.infer<typeof UserDtoSchema>;

/** Returned by login, register and GET /auth/session. The CSRF token must be sent as X-CSRF-Token on mutations. */
export const SessionResponseSchema = z.object({
  user: UserDtoSchema,
  csrfToken: z.string().min(1),
  /** Until when sensitive actions (approving purchases) are allowed without re-entering the password. */
  stepUpExpiresAt: z.string().nullable(),
});
export type SessionResponse = z.infer<typeof SessionResponseSchema>;

export const CSRF_HEADER = 'X-CSRF-Token';

/** Step-up re-authentication: confirm the password before sensitive actions. */
export const StepUpInputSchema = z.object({ password: z.string().min(1).max(256) });
export const StepUpResponseSchema = z.object({ stepUpExpiresAt: z.string() });
export type StepUpResponse = z.infer<typeof StepUpResponseSchema>;
