import { useState } from 'react';
import { defaultVisibility } from '@razem/contracts';
import { AddButton, EmptyState, PrivacyPicker, ScreenHeader, Section, TextField } from '../ui/components.js';
import { FormScreen, useFormValues } from '../ui/form.js';
import type { Errors } from '../ui/form.js';
import { useServices } from '../services.js';
import type { Visibility } from '../services.js';
import { contractData, requiredText } from './validation.js';

export function ShoppingScreen() {
  return (
    <>
      <ScreenHeader title="Zakupy" action={<AddButton label="Nowa lista zakupów" to="/zakupy/nowa" />} />
      <Section>
        <EmptyState icon="shopping" title="Nie ma jeszcze list" text="Lista może być wspólna albo tylko Twoja. Kupione rzeczy trafiają na dół listy."
          action={{ label: 'Utwórz listę', to: '/zakupy/nowa' }} />
      </Section>
    </>
  );
}

type ListForm = { name: string; visibility: Visibility };
export function NewShoppingListScreen() {
  const { saveRecord } = useServices();
  const { values, set } = useFormValues<ListForm>({ name: '', visibility: defaultVisibility('shopping_list') });
  const [errors, setErrors] = useState<Errors<ListForm>>({});
  return (
    <FormScreen title="Nowa lista" cancelTo="/zakupy" doneTo="/zakupy" errors={errors} setErrors={setErrors}
      validate={() => ({ name: requiredText(values.name, 'nazwę listy') })}
      onSubmit={() => saveRecord({ entityType: 'shopping_list', visibility: values.visibility, data: contractData('shopping_list', { name: values.name.trim() }) })}>
      <div className="group">
        <TextField label="Nazwa listy" value={values.name} onValue={set('name')} error={errors.name}
          placeholder="np. Biedronka w sobotę" autoComplete="off" enterKeyHint="done" maxLength={400} />
      </div>
      <div className="group">
        <PrivacyPicker subject="tę listę" value={values.visibility} onChange={set('visibility')} />
        <p className="field__hint">Wszystkie pozycje na liście mają tę samą widoczność co lista.</p>
      </div>
    </FormScreen>
  );
}
