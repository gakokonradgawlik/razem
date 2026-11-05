import type { Settings } from '@razem/contracts';

/** Older installed PWAs use a strict two-field notification schema. */
export function settingsForClient(settings: Settings, extended: boolean): Settings {
  if (extended) return settings;
  return { ...settings, notifications: {
    includeTitles: settings.notifications.includeTitles,
    shoppingNotifications: settings.notifications.shoppingNotifications,
  } };
}
