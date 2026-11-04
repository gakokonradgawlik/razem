// Form screen with iOS-style bar (Anuluj · title · Zapisz). Validation errors are
// shown next to each field, the first invalid field receives focus and a summary
// is announced. Values are plain React state: they are never cleared on an error.
import { useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, navigate } from '../router.js';
import { failureMessage } from '../services.js';
import type { ActionResult } from '../services.js';
import { Notice } from './components.js';

export type Errors<T> = { [K in keyof T]?: string | undefined };

export function useFormValues<T extends Record<string, unknown>>(initial: T) {
  const [values, setValues] = useState(initial);
  const set = <K extends keyof T>(key: K) => (value: T[K]) => setValues((current) => ({ ...current, [key]: value }));
  return { values, setValues, set };
}

export function FormScreen<T>({ title, cancelTo, doneTo, submitLabel = 'Zapisz', validate, onSubmit, errors, setErrors, children, intro }: {
  title: string; cancelTo: string; doneTo?: string; submitLabel?: string;
  validate: () => Errors<T>; onSubmit: () => Promise<ActionResult>;
  errors: Errors<T>; setErrors: (errors: Errors<T>) => void; children: ReactNode; intro?: ReactNode;
}) {
  const form = useRef<HTMLFormElement>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const invalidCount = Object.values(errors).filter(Boolean).length;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const found = validate();
    setErrors(found);
    setFailure(null);
    if (Object.values(found).some(Boolean)) {
      // Wait for React to render aria-invalid, then focus the first invalid control.
      requestAnimationFrame(() => form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    setBusy(true);
    try {
      const result = await onSubmit();
      if (result.ok) { if (doneTo) navigate(doneTo); return; }
      setFailure(failureMessage(result));
    } catch {
      setFailure('Nie zapisano. Spróbuj ponownie.');
    } finally { setBusy(false); }
  };

  return (
    <form ref={form} className="form-screen" onSubmit={submit} noValidate aria-labelledby="form-title">
      <div className="form-bar">
        <Link to={cancelTo} className="form-bar__button">Anuluj</Link>
        <h1 id="form-title" className="form-bar__title" tabIndex={-1} data-screen-title>{title}</h1>
        <button type="submit" className="form-bar__button form-bar__button--primary" disabled={busy} aria-busy={busy || undefined}>{submitLabel}</button>
      </div>
      <div className="form-body">
        {intro}
        <div aria-live="assertive" className="form-messages">
          {invalidCount > 0 && <Notice tone="danger" role="alert">Popraw {invalidCount === 1 ? 'zaznaczone pole' : 'zaznaczone pola'}. Wpisana treść została zachowana.</Notice>}
          {failure && <Notice tone="danger" role="alert">{failure} Wpisana treść została zachowana.</Notice>}
        </div>
        {children}
      </div>
    </form>
  );
}
