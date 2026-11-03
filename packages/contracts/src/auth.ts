import { z } from 'zod';
import { householdSchema, userSchema } from './model.js';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;
export const loginSchema = z.string().trim().toLowerCase().min(3).max(254).regex(/^[^\s]+$/, 'Login bez spacji');
// Login request accepts any short string: policy is checked only for new passwords.
export const loginRequestSchema = z.strictObject({
  login: z.string().min(1).max(254), password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export const passwordChangeRequestSchema = z.strictObject({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export const meResponseSchema = z.strictObject({ user: userSchema, household: householdSchema });
export type MeResponse = z.infer<typeof meResponseSchema>;

/** Checks a new (temporary or own) password; returns a Polish reason, never echoes it. */
export function passwordProblem(password: string, login: string): string | null {
  const length = [...password.normalize('NFC')].length;
  if (length < PASSWORD_MIN_LENGTH) return `Hasło musi mieć co najmniej ${PASSWORD_MIN_LENGTH} znaków`;
  if (length > PASSWORD_MAX_LENGTH) return `Hasło może mieć najwyżej ${PASSWORD_MAX_LENGTH} znaków`;
  if (password.trim() !== password) return 'Hasło nie może zaczynać ani kończyć się spacją';
  if (new Set(password).size < 4) return 'Hasło jest zbyt powtarzalne';
  const local = login.trim().toLowerCase().split('@')[0] ?? '';
  if (local.length >= 4 && password.toLowerCase().includes(local)) return 'Hasło nie może zawierać loginu';
  return null;
}
