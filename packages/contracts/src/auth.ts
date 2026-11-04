import { z } from 'zod';
import { householdSchema, userSchema } from './model.js';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;
export const loginSchema = z.string().trim().toLowerCase().min(3).max(254).regex(/^[^\s]+$/, 'Login bez spacji');
// Match CLI policy and hashing: NFC, then Unicode code points (not UTF-16 units).
// Login checks only the input bound; strength policy applies to new passwords.
const passwordInputSchema = z.string().transform((value) => value.normalize('NFC'))
  .refine((value) => [...value].length >= 1 && [...value].length <= PASSWORD_MAX_LENGTH,
    'Hasło musi mieć od 1 do 256 znaków po NFC');
export const loginRequestSchema = z.strictObject({
  login: z.string().min(1).max(254), password: passwordInputSchema,
});
export const passwordChangeRequestSchema = z.strictObject({
  currentPassword: passwordInputSchema,
  newPassword: passwordInputSchema,
});
export const meResponseSchema = z.strictObject({ user: userSchema, household: householdSchema });
export type MeResponse = z.infer<typeof meResponseSchema>;

/** Checks a new (temporary or own) password; returns a Polish reason, never echoes it. */
export function passwordProblem(password: string, login: string): string | null {
  password = password.normalize('NFC');
  const length = [...password].length;
  if (length < PASSWORD_MIN_LENGTH) return `Hasło musi mieć co najmniej ${PASSWORD_MIN_LENGTH} znaków`;
  if (length > PASSWORD_MAX_LENGTH) return `Hasło może mieć najwyżej ${PASSWORD_MAX_LENGTH} znaków`;
  if (password.trim() !== password) return 'Hasło nie może zaczynać ani kończyć się spacją';
  if (new Set(password).size < 4) return 'Hasło jest zbyt powtarzalne';
  const local = login.trim().toLowerCase().split('@')[0] ?? '';
  if (local.length >= 4 && password.toLowerCase().includes(local)) return 'Hasło nie może zawierać loginu';
  return null;
}
