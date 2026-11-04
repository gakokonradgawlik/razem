import { describe, expect, it } from 'vitest';
import { loginRequestSchema, passwordChangeRequestSchema, passwordProblem } from './auth.js';

describe('wspólne granice haseł Unicode', () => {
  it.each(['😀😁😂😃'.repeat(64), 'a\u0301e\u0301i\u0301o\u0301'.repeat(64)])(
    'normalizuje przed limitem, przyjmuje 256 i odrzuca 257 punktów kodowych', (password) => {
      expect(passwordProblem(password, 'test@example.test')).toBeNull();
      expect(loginRequestSchema.parse({ login: 'test', password }).password).toBe(password.normalize('NFC'));
      expect(passwordChangeRequestSchema.parse({ currentPassword: password, newPassword: password }))
        .toEqual({ currentPassword: password.normalize('NFC'), newPassword: password.normalize('NFC') });
      expect(passwordProblem(password + 'x', 'test@example.test')).not.toBeNull();
      expect(loginRequestSchema.safeParse({ login: 'test', password: password + 'x' }).success).toBe(false);
    },
  );
  it('sprawdza również siłę na NFC, a logowanie dopuszcza krótkie stare hasło', () => {
    expect(passwordProblem('e\u0301ée\u0301é'.repeat(4), 'test')).toBe('Hasło jest zbyt powtarzalne');
    expect(loginRequestSchema.parse({ login: 'test', password: 'x' }).password).toBe('x');
    expect(loginRequestSchema.safeParse({ login: 'test', password: '' }).success).toBe(false);
  });
});
