import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, passwordProblem } from '@razem/contracts';
import { Notice, TextField } from '../ui/components.js';
import { FormScreen, useFormValues } from '../ui/form.js';
import type { Errors } from '../ui/form.js';
import { BrandMark, Icon } from '../ui/icons.js';
import { Link, navigate } from '../router.js';
import { failureMessage, useServices } from '../services.js';

const codePoints = (value: string) => [...value.normalize('NFC')].length;

function PasswordField({ label, value, onValue, error, autoComplete, hint }: { label: string; value: string; onValue: (value: string) => void; error?: string | undefined; autoComplete: string; hint?: string }) {
  const [visible, setVisible] = useState(false);
  return (
    <TextField label={label} type={visible ? 'text' : 'password'} value={value} onValue={onValue} error={error} hint={hint}
      autoComplete={autoComplete} autoCapitalize="none" autoCorrect="off" spellCheck={false}
      trailing={<button type="button" className="icon-button field__trailing" aria-label={visible ? 'Ukryj hasło' : 'Pokaż hasło'} aria-pressed={visible}
        onClick={() => setVisible((current) => !current)}><Icon name={visible ? 'eyeOff' : 'eye'} size={20} /></button>} />
  );
}

type LoginForm = { login: string; password: string };
export function LoginScreen() {
  const services = useServices();
  const form = useRef<HTMLFormElement>(null);
  const { values, set } = useFormValues<LoginForm>({ login: '', password: '' });
  const [errors, setErrors] = useState<Errors<LoginForm>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const found: Errors<LoginForm> = {
      login: values.login.trim() ? undefined : 'Wpisz login.',
      password: !values.password ? 'Wpisz hasło.' : codePoints(values.password) > PASSWORD_MAX_LENGTH ? `Hasło może mieć najwyżej ${PASSWORD_MAX_LENGTH} znaków.` : undefined,
    };
    setErrors(found); setFailure(null);
    if (found.login || found.password) { requestAnimationFrame(() => form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()); return; }
    setBusy(true);
    try {
      const result = await services.login({ login: values.login.trim(), password: values.password });
      if (result.ok) {
        const target = new URLSearchParams(window.location.search).get('powiadomienie');
        navigate(target && /^\/powiadomienie\/(task|calendar_event|important_date|shopping_list|shopping_item)\/[0-9a-f-]{36}$/.test(target) ? target : '/', { replace: true });
      }
      else setFailure(failureMessage(result));
    } catch { setFailure('Nie udało się zalogować. Spróbuj ponownie.'); } finally { setBusy(false); }
  };

  return (
    <main className="auth" id="main">
      <form ref={form} className="auth__card" onSubmit={submit} noValidate aria-labelledby="login-title">
        <BrandMark size={64} />
        <h1 id="login-title" tabIndex={-1} data-screen-title>Zaloguj się do Razem</h1>
        <p className="auth__lead">Konta zakłada administrator domowego serwera. Nie ma publicznej rejestracji.</p>
        <div aria-live="assertive">{failure && <Notice tone="danger" role="alert">{failure}</Notice>}</div>
        <div className="group">
          <TextField label="Login" value={values.login} onValue={set('login')} error={errors.login} autoComplete="username"
            autoCapitalize="none" autoCorrect="off" spellCheck={false} inputMode="email" enterKeyHint="next" />
          <PasswordField label="Hasło" value={values.password} onValue={set('password')} error={errors.password} autoComplete="current-password" />
        </div>
        <button type="submit" className="button button--filled button--block" disabled={busy} aria-busy={busy || undefined}>{busy ? 'Logowanie…' : 'Zaloguj się'}</button>
        <Link to="/" className="button button--plain button--block">Wróć do aplikacji</Link>
      </form>
    </main>
  );
}

type PasswordForm = { currentPassword: string; newPassword: string; repeat: string };
export function ChangePasswordScreen() {
  const services = useServices();
  const login = services.session?.login ?? '';
  const { values, set } = useFormValues<PasswordForm>({ currentPassword: '', newPassword: '', repeat: '' });
  const [errors, setErrors] = useState<Errors<PasswordForm>>({});
  const forced = services.session?.mustChangePassword ?? false;
  const validate = (): Errors<PasswordForm> => {
    const problem = values.newPassword ? passwordProblem(values.newPassword, login) : 'Wpisz nowe hasło.';
    return {
      currentPassword: values.currentPassword ? undefined : 'Wpisz obecne hasło.',
      newPassword: problem ? `${problem.replace(/\.$/, '')}.` : values.newPassword.normalize('NFC') === values.currentPassword.normalize('NFC') ? 'Nowe hasło musi różnić się od obecnego.' : undefined,
      repeat: values.repeat !== values.newPassword ? 'Hasła nie są takie same.' : undefined,
    };
  };
  return (
    <FormScreen title="Zmiana hasła" cancelTo="/ustawienia" doneTo="/ustawienia" errors={errors} setErrors={setErrors} validate={validate}
      onSubmit={() => services.changePassword({ currentPassword: values.currentPassword, newPassword: values.newPassword })}
      intro={forced ? <Notice tone="warning" title="Ustaw własne hasło">Logujesz się hasłem tymczasowym. Ustaw własne, aby korzystać z aplikacji.</Notice> : undefined}>
      <div className="group">
        <PasswordField label="Obecne hasło" value={values.currentPassword} onValue={set('currentPassword')} error={errors.currentPassword} autoComplete="current-password" />
      </div>
      <div className="group">
        <PasswordField label="Nowe hasło" value={values.newPassword} onValue={set('newPassword')} error={errors.newPassword} autoComplete="new-password"
          hint={`Co najmniej ${PASSWORD_MIN_LENGTH} znaków, bez spacji na początku i końcu. Możesz użyć kilku słów.`} />
        <PasswordField label="Powtórz nowe hasło" value={values.repeat} onValue={set('repeat')} error={errors.repeat} autoComplete="new-password" />
      </div>
      <p className="field__hint">Po zmianie hasła pozostałe urządzenia zostaną wylogowane.</p>
    </FormScreen>
  );
}
