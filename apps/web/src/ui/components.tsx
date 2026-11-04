// Shared building blocks. Every control is ≥44×44 CSS px (see style.css), has a
// visible or accessible name, and text inputs use ≥16 px so iOS does not zoom.
import { useEffect, useId, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';
import { Link } from '../router.js';
import { Icon } from './icons.js';
import type { IconName } from './icons.js';
import { syncLabel, useSyncState } from '../services.js';
import type { SyncState, Visibility } from '../services.js';

// ---------- Screen structure ----------

export function ScreenHeader({ title, subtitle, action, back }: {
  title: string; subtitle?: string; action?: ReactNode; back?: { to: string; label: string };
}) {
  return (
    <header className="screen-header">
      {back && (
        <div className="screen-header__bar">
          <Link to={back.to} className="nav-back"><Icon name="chevronLeft" /><span>{back.label}</span></Link>
        </div>
      )}
      <div className="screen-header__row">
        <div className="screen-header__titles">
          <h1 tabIndex={-1} data-screen-title>{title}</h1>
          {subtitle && <p className="screen-header__subtitle">{subtitle}</p>}
        </div>
        {action}
      </div>
    </header>
  );
}

export function AddButton({ label, to, onClick, ...rest }: { label: string; to?: string; onClick?: () => void } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'>) {
  if (to) return <Link to={to} className="icon-button icon-button--filled" aria-label={label} title={label}><Icon name="plus" /></Link>;
  return <button type="button" className="icon-button icon-button--filled" aria-label={label} title={label} onClick={onClick} {...rest}><Icon name="plus" /></button>;
}

export function Section({ title, children, footer, id }: { title?: string; children: ReactNode; footer?: ReactNode; id?: string }) {
  const generated = useId();
  const headingId = id ?? generated;
  return (
    <section className="section" aria-labelledby={title ? headingId : undefined}>
      {title && <h2 className="section__title" id={headingId}>{title}</h2>}
      {children}
      {footer && <p className="section__footer">{footer}</p>}
    </section>
  );
}

// ---------- Lists ----------

export function List({ children, label }: { children: ReactNode; label?: string }) {
  return <ul className="list" aria-label={label}>{children}</ul>;
}

type RowContent = { icon?: IconName; iconTone?: string; title: string; detail?: ReactNode; value?: ReactNode };
function RowBody({ icon, iconTone, title, detail, value }: RowContent) {
  return (
    <>
      {icon && <span className={`row__icon ${iconTone ? `row__icon--${iconTone}` : ''}`}><Icon name={icon} size={20} /></span>}
      <span className="row__text"><span className="row__title">{title}</span>{detail && <span className="row__detail">{detail}</span>}</span>
      {value && <span className="row__value">{value}</span>}
    </>
  );
}

export function ListRow(props: RowContent & ({ to: string; onClick?: never } | { onClick: () => void; to?: never } | { to?: never; onClick?: never }) & { disabled?: boolean }) {
  const { to, onClick, disabled, ...content } = props;
  if (to && !disabled) return <li><Link to={to} className="row row--link"><RowBody {...content} /><span className="row__chevron"><Icon name="chevronRight" size={18} /></span></Link></li>;
  if (onClick) return <li><button type="button" className="row row--link" onClick={onClick} disabled={disabled}><RowBody {...content} /></button></li>;
  return <li className="row" aria-disabled={disabled || undefined}><RowBody {...content} /></li>;
}

// ---------- Messages ----------

export function EmptyState({ icon, title, text, action }: { icon: IconName; title: string; text: string; action?: { label: string; to: string } }) {
  return (
    <div className="empty">
      <span className="empty__icon"><Icon name={icon} size={32} /></span>
      <p className="empty__title">{title}</p>
      <p className="empty__text">{text}</p>
      {action && <Link to={action.to} className="button button--tinted">{action.label}</Link>}
    </div>
  );
}

export function Notice({ tone = 'info', title, children, role }: { tone?: 'info' | 'warning' | 'danger' | 'success'; title?: string; children: ReactNode; role?: 'alert' | 'status' }) {
  const icon: IconName = tone === 'success' ? 'check' : tone === 'info' ? 'clock' : 'alert';
  return (
    <div className={`notice notice--${tone}`} role={role}>
      <Icon name={icon} size={20} />
      <div>{title && <p className="notice__title">{title}</p>}<div className="notice__body">{children}</div></div>
    </div>
  );
}

export function SyncBadge({ state: forced }: { state?: SyncState }) {
  const current = useSyncState();
  const state = forced ?? current;
  const { text, tone } = syncLabel(state);
  const icon: IconName = state.kind === 'offline' || state.kind === 'server_unavailable' ? 'cloudOff' : state.kind === 'conflict' ? 'alert' : 'cloud';
  return (
    <p className={`sync-badge sync-badge--${tone}`} role="status" aria-live="polite">
      <Icon name={icon} size={18} /><span>{text}</span>
    </p>
  );
}

// ---------- Buttons & menu ----------

export function Button({ variant = 'tinted', children, ...rest }: { variant?: 'filled' | 'tinted' | 'plain' | 'destructive' } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={`button button--${variant}`} {...rest}>{children}</button>;
}

export type MenuItem = { label: string; icon: IconName; to: string };
/** Disclosure menu (button + list of links). Escape and outside click close it. */
export function Menu({ label, items, icon = 'plus' }: { label: string; items: MenuItem[]; icon?: IconName }) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); button.current?.focus(); } };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', key);
    root.current?.querySelector<HTMLElement>('.menu a')?.focus();
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', key); };
  }, [open]);
  return (
    <div className="menu-root" ref={root}>
      <button ref={button} type="button" className="icon-button icon-button--filled" aria-label={label} title={label}
        aria-expanded={open} aria-controls={menuId} onClick={() => setOpen((value) => !value)}>
        <Icon name={icon} />
      </button>
      {open && (
        <ul className="menu" id={menuId} aria-label={label}>
          {items.map((item) => (
            <li key={item.to}><Link to={item.to} className="menu__item" onClick={() => setOpen(false)}><Icon name={item.icon} size={20} /><span>{item.label}</span></Link></li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (value: T) => void }) {
  const name = useId();
  return (
    <fieldset className="segmented">
      <legend className="visually-hidden">{label}</legend>
      {options.map((option) => (
        <label key={option.value} className="segmented__option">
          <input type="radio" name={name} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} />
          <span>{option.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

// ---------- Form fields ----------

type FieldShell = { label: string; error?: string | undefined; hint?: string | undefined; children: (ids: { id: string; describedBy: string | undefined }) => ReactNode };
function Field({ label, error, hint, children }: FieldShell) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`field ${error ? 'field--invalid' : ''}`}>
      <label className="field__label" htmlFor={id}>{label}</label>
      {children({ id, describedBy })}
      {error && <p className="field__error" id={errorId}><Icon name="alert" size={16} /> {error}</p>}
      {hint && <p className="field__hint" id={hintId}>{hint}</p>}
    </div>
  );
}

type TextFieldProps = { label: string; error?: string | undefined; hint?: string | undefined; value: string; onValue: (value: string) => void; trailing?: ReactNode }
  & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'id'>;
export function TextField({ label, error, hint, value, onValue, trailing, ...rest }: TextFieldProps) {
  return (
    <Field label={label} error={error} hint={hint}>
      {({ id, describedBy }) => (
        <div className="field__control">
          <input id={id} className="input" value={value} onChange={(event) => onValue(event.target.value)}
            aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...rest} />
          {trailing}
        </div>
      )}
    </Field>
  );
}

type TextAreaProps = { label: string; error?: string | undefined; hint?: string; value: string; onValue: (value: string) => void }
  & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange' | 'id'>;
export function TextArea({ label, error, hint, value, onValue, ...rest }: TextAreaProps) {
  return (
    <Field label={label} error={error} hint={hint}>
      {({ id, describedBy }) => (
        <textarea id={id} className="input input--multiline" value={value} onChange={(event) => onValue(event.target.value)}
          aria-invalid={error ? true : undefined} aria-describedby={describedBy} rows={4} {...rest} />
      )}
    </Field>
  );
}

export function SelectField<T extends string>({ label, value, options, onValue, error, hint }: { label: string; value: T; options: { value: T; label: string; disabled?: boolean }[]; onValue: (value: T) => void; error?: string | undefined; hint?: string | undefined }) {
  return (
    <Field label={label} error={error} hint={hint}>
      {({ id, describedBy }) => (
        <select id={id} className="input input--select" value={value} onChange={(event) => onValue(event.target.value as T)}
          aria-invalid={error ? true : undefined} aria-describedby={describedBy}>
          {options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
        </select>
      )}
    </Field>
  );
}

/** Native date/time pickers: iOS shows its own wheel, values stay ISO strings. */
export function DateField({ label, type = 'date', ...props }: Omit<TextFieldProps, 'type'> & { type?: 'date' | 'time' }) {
  return <TextField label={label} type={type} {...props} />;
}

export function Toggle({ label, checked, onChange, hint, disabled }: { label: string; checked: boolean; onChange: (checked: boolean) => void; hint?: string; disabled?: boolean }) {
  const hintId = useId();
  return (
    <label className="toggle">
      <span className="toggle__text"><span>{label}</span>{hint && <span className="field__hint" id={hintId}>{hint}</span>}</span>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} aria-describedby={hint ? hintId : undefined} />
    </label>
  );
}

const privacyCopy: Record<Visibility, { title: string; text: string; icon: IconName }> = {
  shared: { title: 'Wspólne', text: 'Widzicie oboje', icon: 'people' },
  private: { title: 'Tylko ja', text: 'Widzisz tylko Ty', icon: 'lock' },
};
/** Visibility choice shown before saving; text label, never colour alone. */
export function PrivacyPicker({ value, onChange, subject }: { value: Visibility; onChange: (value: Visibility) => void; subject: string }) {
  const name = useId();
  const noteId = useId();
  return (
    <fieldset className="privacy" aria-describedby={noteId}>
      <legend className="field__label">Kto widzi {subject}?</legend>
      <div className="privacy__options">
        {(['shared', 'private'] as const).map((option) => (
          <label key={option} className="privacy__option">
            <input type="radio" name={name} value={option} checked={value === option} onChange={() => onChange(option)} />
            <span className="privacy__card">
              <Icon name={privacyCopy[option].icon} size={22} />
              <span className="privacy__title">{privacyCopy[option].title}</span>
              <span className="privacy__text">{privacyCopy[option].text}</span>
            </span>
          </label>
        ))}
      </div>
      <p className="field__hint" id={noteId}>Zapiszesz jako: <strong>{privacyCopy[value].title}</strong>. Widoczności nie można zmienić po zapisaniu.</p>
    </fieldset>
  );
}

export function PrivacyTag({ value }: { value: Visibility }) {
  return <span className={`tag tag--${value}`}><Icon name={privacyCopy[value].icon} size={14} />{privacyCopy[value].title}</span>;
}
