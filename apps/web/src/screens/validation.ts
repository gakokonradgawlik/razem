import { dataSchemas } from '@razem/contracts';
import type { EntityType } from '@razem/contracts';

/** Polish message for a required title-like field (contract: trimmed 1–max chars). */
export function requiredText(value: string, what: string, max = 200): string | undefined {
  if (value.trim().length === 0) return `Wpisz ${what}.`;
  if (value.trim().length > max) return `Maksymalnie ${max} znaków (teraz ${value.trim().length}).`;
  return undefined;
}

export function maxText(value: string, max: number): string | undefined {
  return value.length > max ? `Maksymalnie ${max} znaków (teraz ${value.length}).` : undefined;
}

/** Final guard: the payload handed to the data layer must match the shared contract. */
export function contractData<T extends EntityType>(type: T, data: Record<string, unknown>): Record<string, unknown> {
  return dataSchemas[type].parse(data) as Record<string, unknown>;
}
