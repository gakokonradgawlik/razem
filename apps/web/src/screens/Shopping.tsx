import { useRef, useState } from 'react';
import { defaultVisibility } from '@razem/contracts';
import { AddButton, EmptyState, List, ListRow, Notice, PrivacyPicker, PrivacyTag, ScreenHeader, Section, TextArea, TextField, Button } from '../ui/components.js';
import { FormScreen, useFormValues } from '../ui/form.js';
import type { Errors } from '../ui/form.js';
import { Link, pathFor, useParam } from '../router.js';
import { failureMessage, useServices } from '../services.js';
import type { Visibility } from '../services.js';
import { contractData, maxText, requiredText } from './validation.js';
import { DeleteRecord, FixedPrivacy, LoadingNotice, MissingRecord, RecordGate, loaded, persist, useRecord, useRecords } from './records.js';
import type { FormMode, Typed } from './records.js';

export const shoppingPaths = {
  list: '/zakupy/:listId',
  editList: '/zakupy/:listId/edycja',
  newItem: '/zakupy/:listId/pozycje/nowa',
  item: '/zakupy/:listId/pozycje/:itemId',
} as const;
const listPath = (listId: string) => pathFor(shoppingPaths.list, { listId });

export function ShoppingScreen() {
  const [state] = useRecords('shopping_list');
  const lists = loaded(state);
  return (
    <>
      <ScreenHeader title="Zakupy" action={<AddButton label="Nowa lista zakupów" to="/zakupy/nowa" />} />
      <Section>
        {lists === null ? <LoadingNotice />
          : lists.length === 0
            ? <EmptyState icon="shopping" title="Nie ma jeszcze list" text="Lista może być wspólna albo tylko Twoja. Kupione rzeczy trafiają na dół listy."
              action={{ label: 'Utwórz listę', to: '/zakupy/nowa' }} />
            : <List label="Listy zakupów">
              {[...lists].sort((a, b) => a.data.name.localeCompare(b.data.name, 'pl')).map((list) => (
                <ListRow key={list.id} to={listPath(list.id)} icon="shopping" iconTone="green" title={list.data.name} value={<PrivacyTag value={list.visibility} />} />
              ))}
            </List>}
      </Section>
    </>
  );
}

// ---------- List detail: items, quick check with undo ----------

type Item = Typed<'shopping_item'>;
export function ShoppingListScreen() {
  const listId = useParam('listId');
  const [listState] = useRecord('shopping_list', listId);
  const back = { to: '/zakupy', label: 'Zakupy' };
  if (listState.status !== 'ok') return <MissingRecord state={listState} title="Lista zakupów" back={back} />;
  const list = listState.value;
  return (
    <>
      <ScreenHeader title={list.data.name} back={back} />
      <p className="screen-meta"><PrivacyTag value={list.visibility} /></p>
      <ShoppingItems list={list} />
      <Section>
        <List label="Lista">
          <ListRow to={pathFor(shoppingPaths.editList, { listId })} icon="edit" iconTone="blue" title="Zmień nazwę listy" />
        </List>
      </Section>
      <Section><DeleteRecord entityType="shopping_list" record={list} what="listę" doneTo="/zakupy" /></Section>
    </>
  );
}

function ShoppingItems({ list }: { list: Typed<'shopping_list'> }) {
  const { updateRecord } = useServices();
  const [state, reload] = useRecords('shopping_item', list.id);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string; undo?: { id: string; checked: boolean } } | null>(null);
  const items = loaded(state)?.filter((item) => item.data.listId === list.id);

  // Checking is written at once (no Zapisz); success offers Cofnij, failure is reported.
  const toggle = async (item: Item, checked: boolean, isUndo = false) => {
    setMessage(null);
    const result = await updateRecord({ entityType: 'shopping_item', id: item.id, baseVersion: item.version, patch: { checked } }).catch(() => ({ ok: false as const, reason: 'storage_unavailable' as const }));
    if (!result.ok) { setMessage({ tone: 'danger', text: `Nie zmieniono „${item.data.name}”. ${failureMessage(result)}` }); return; }
    reload();
    if (!isUndo) setMessage({ tone: 'success', text: checked ? `Kupione: ${item.data.name}` : `Do kupienia: ${item.data.name}`, undo: { id: item.id, checked: !checked } });
  };

  // Undo works on the current (reloaded) version of the item.
  const undo = ({ id, checked }: { id: string; checked: boolean }) => {
    const current = items?.find((item) => item.id === id);
    if (current) void toggle(current, checked, true);
  };
  if (!items) return <Section><LoadingNotice /></Section>;
  // UUID breaks ties from concurrent devices/the same millisecond. Neither checking
  // nor ACK/pull changes sortKey, so unchecking restores the original place.
  const sorted = [...items].sort((a, b) => a.data.sortKey - b.data.sortKey || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const open = sorted.filter((item) => !item.data.checked), done = sorted.filter((item) => item.data.checked);
  const row = (item: Item) => (
    <li key={item.id} className="row item-row">
      <label className="check">
        <input type="checkbox" checked={item.data.checked} onChange={(event) => toggle(item, event.target.checked)} />
        <span className="visually-hidden">Kupione: {item.data.name}</span>
      </label>
      <Link to={pathFor(shoppingPaths.item, { listId: list.id, itemId: item.id })} className="item-row__link">
        <span className="row__text">
          <span className={`row__title ${item.data.checked ? 'row__title--done' : ''}`}>{item.data.name}</span>
          {(item.data.quantity || item.data.note) && <span className="row__detail">{[item.data.quantity, item.data.note].filter(Boolean).join(' · ')}</span>}
        </span>
      </Link>
    </li>
  );
  return (
    <>
      <QuickShoppingItem list={list} onAdded={reload} />
      <div aria-live="polite" className="form-messages">
        {message && (
          <Notice tone={message.tone} role={message.tone === 'danger' ? 'alert' : 'status'}>
            <span className="notice__inline">{message.text}
              {message.undo && <Button variant="plain" onClick={() => undo(message.undo!)}>Cofnij</Button>}
            </span>
          </Notice>
        )}
      </div>
      <Section title="Do kupienia">
        {items.length === 0
          ? <EmptyState icon="shopping" title="Lista jest pusta" text="Dopisz nazwę powyżej. Ilość i uwagę możesz uzupełnić w formularzu pozycji." />
          : open.length === 0 ? <EmptyState icon="check" title="Wszystko kupione" text="Kupione pozycje są niżej; można je odznaczyć." />
            : <ul className="list" aria-label="Do kupienia">{open.map(row)}</ul>}
      </Section>
      {done.length > 0 && <Section title="Kupione"><ul className="list" aria-label="Kupione">{done.map(row)}</ul></Section>}
    </>
  );
}

function QuickShoppingItem({ list, onAdded }: { list: Typed<'shopping_list'>; onAdded: () => void }) {
  const { saveRecord } = useServices();
  const form = useRef<HTMLFormElement>(null);
  const submitting = useRef(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <Section title="Dopisz do listy">
      <form ref={form} className="shopping-quick group" aria-label="Szybkie dodawanie" noValidate onSubmit={async (event) => {
        event.preventDefault();
        if (submitting.current) return;
        const problem = requiredText(name, 'nazwę');
        setError(problem); setMessage(null);
        if (problem) { form.current?.querySelector('input')?.focus(); return; }
        submitting.current = true; setBusy(true);
        try {
          const result = await saveRecord({ entityType: 'shopping_item', data: {
            listId: list.id, name: name.trim(), quantity: '', note: '', checked: false, sortKey: Date.now(),
          } });
          if (!result.ok) { setMessage({ ok: false, text: failureMessage(result) }); return; }
          setMessage({ ok: true, text: `Dodano: ${name.trim()}` });
          setName(''); onAdded();
          form.current?.querySelector('input')?.focus();
        } catch { setMessage({ ok: false, text: 'Nie zapisano. Spróbuj ponownie.' }); }
        finally { submitting.current = false; setBusy(false); }
      }}>
        <TextField label="Nazwa produktu" value={name} onValue={setName} error={error} maxLength={400}
          placeholder="np. Świeże bułki" autoComplete="off" enterKeyHint="done" readOnly={busy} />
        <div className="shopping-quick__actions">
          <Link to={pathFor(shoppingPaths.newItem, { listId: list.id })} className="button button--plain">Dodaj pozycję</Link>
          <Button type="submit" variant="filled" disabled={busy} aria-busy={busy || undefined}>Dodaj</Button>
        </div>
        <p className="field__hint">Ilość i uwagę podasz w formularzu „Dodaj pozycję”. Widoczność jak lista: <PrivacyTag value={list.visibility} /></p>
        {message && <Notice tone={message.ok ? 'success' : 'danger'} role={message.ok ? 'status' : 'alert'}>{message.text}</Notice>}
      </form>
    </Section>
  );
}

// ---------- Shopping list form (create / rename) ----------

type ListForm = { name: string; visibility: Visibility };
function ShoppingListForm({ mode }: { mode: FormMode<'shopping_list'> }) {
  const services = useServices();
  const editing = mode.kind === 'edit' ? mode.record : null;
  const { values, set } = useFormValues<ListForm>({ name: editing?.data.name ?? '', visibility: editing?.visibility ?? defaultVisibility('shopping_list') });
  const [errors, setErrors] = useState<Errors<ListForm>>({});
  const back = editing ? listPath(editing.id) : '/zakupy';
  return (
    <FormScreen title={editing ? 'Edytuj listę' : 'Nowa lista'} cancelTo={back} doneTo={back} errors={errors} setErrors={setErrors}
      validate={() => ({ name: requiredText(values.name, 'nazwę listy') })}
      onSubmit={() => persist(services, 'shopping_list', mode, contractData('shopping_list', { name: values.name.trim() }), values.visibility)}>
      <div className="group">
        <TextField label="Nazwa listy" value={values.name} onValue={set('name')} error={errors.name}
          placeholder="np. Biedronka w sobotę" autoComplete="off" enterKeyHint="done" maxLength={400} />
      </div>
      <div className="group">
        {editing ? <FixedPrivacy value={editing.visibility} /> : <PrivacyPicker subject="tę listę" value={values.visibility} onChange={set('visibility')} />}
        <p className="field__hint">Wszystkie pozycje na liście mają tę samą widoczność co lista.</p>
      </div>
    </FormScreen>
  );
}

export const NewShoppingListScreen = () => <ShoppingListForm mode={{ kind: 'create' }} />;
export function EditShoppingListScreen() {
  const listId = useParam('listId');
  return (
    <RecordGate entityType="shopping_list" id={listId} title="Edytuj listę" back={{ to: listPath(listId), label: 'Lista' }}>
      {(record) => <ShoppingListForm mode={{ kind: 'edit', record }} />}
    </RecordGate>
  );
}

// ---------- Item form (create / edit + delete) ----------

type ItemForm = { name: string; quantity: string; note: string };
function ShoppingItemForm({ list, mode }: { list: Typed<'shopping_list'>; mode: FormMode<'shopping_item'> }) {
  const services = useServices();
  const editing = mode.kind === 'edit' ? mode.record : null;
  const { values, set } = useFormValues<ItemForm>({ name: editing?.data.name ?? '', quantity: editing?.data.quantity ?? '', note: editing?.data.note ?? '' });
  const [errors, setErrors] = useState<Errors<ItemForm>>({});
  const back = listPath(list.id);
  const submit = () => persist(services, 'shopping_item', mode, contractData('shopping_item', {
    listId: list.id, name: values.name.trim(), quantity: values.quantity.trim(), note: values.note,
    // Keep this key through checking, editing, restart and sync; UUID breaks ties.
    checked: editing?.data.checked ?? false, sortKey: editing?.data.sortKey ?? Date.now(),
  }));
  return (
    <FormScreen title={editing ? 'Edytuj pozycję' : 'Nowa pozycja'} cancelTo={back} doneTo={back} errors={errors} setErrors={setErrors}
      validate={() => ({ name: requiredText(values.name, 'nazwę'), quantity: maxText(values.quantity.trim(), 100), note: maxText(values.note, 2000) })}
      onSubmit={submit} intro={<p className="form-context">Lista: <strong>{list.data.name}</strong></p>}>
      <div className="group">
        <TextField label="Nazwa" value={values.name} onValue={set('name')} error={errors.name} placeholder="np. Mleko" autoComplete="off" maxLength={400} />
        <TextField label="Ilość (opcjonalnie)" value={values.quantity} onValue={set('quantity')} error={errors.quantity} placeholder="np. 2 l" autoComplete="off" maxLength={200} />
        <TextArea label="Uwaga (opcjonalnie)" value={values.note} onValue={set('note')} error={errors.note} rows={3} placeholder="np. bez laktozy" />
      </div>
      <div className="group"><FixedPrivacy value={list.visibility} inherited="lista" /></div>
      {editing && <DeleteRecord entityType="shopping_item" record={editing} what="pozycję" doneTo={back} />}
    </FormScreen>
  );
}

export function NewShoppingItemScreen() {
  const listId = useParam('listId');
  return (
    <RecordGate entityType="shopping_list" id={listId} title="Nowa pozycja" back={{ to: '/zakupy', label: 'Zakupy' }}>
      {(list) => <ShoppingItemForm list={list} mode={{ kind: 'create' }} />}
    </RecordGate>
  );
}

export function ShoppingItemScreen() {
  const listId = useParam('listId');
  const itemId = useParam('itemId');
  const [item] = useRecord('shopping_item', itemId);
  const back = { to: listPath(listId), label: 'Lista' };
  return (
    <RecordGate entityType="shopping_list" id={listId} title="Pozycja" back={{ to: '/zakupy', label: 'Zakupy' }}>
      {(list) => item.status === 'ok' && item.value.data.listId === list.id
        ? <ShoppingItemForm list={list} mode={{ kind: 'edit', record: item.value }} />
        // An item of another list is treated as missing (no cross-list leaks through the URL).
        : <MissingRecord state={item.status === 'ok' ? { status: 'not_found' } : item} title="Pozycja" back={back} />}
    </RecordGate>
  );
}
