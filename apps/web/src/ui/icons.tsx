// Local, hand-drawn line icons (24×24, currentColor). No icon fonts or remote assets,
// so they work offline and inherit the theme colour. Always decorative: the control
// that contains an icon carries its own accessible name.
import type { ReactElement } from 'react';

const paths = {
  today: <><rect x="3.5" y="5" width="17" height="15.5" rx="3" /><path d="M3.5 10h17M8 3v4M16 3v4" /><circle cx="12" cy="15" r="1.6" fill="currentColor" stroke="none" /></>,
  shopping: <><path d="M5 8h14l-1.2 11.2a1.5 1.5 0 0 1-1.5 1.3H7.7a1.5 1.5 0 0 1-1.5-1.3Z" /><path d="M9 10V6.5a3 3 0 0 1 6 0V10" /></>,
  tasks: <><circle cx="12" cy="12" r="8.5" /><path d="m8.2 12.2 2.6 2.6 5-5.4" /></>,
  calendar: <><rect x="3.5" y="5" width="17" height="15.5" rx="3" /><path d="M3.5 10h17M8 3v4M16 3v4M7.5 14h2M11 14h2M14.5 14h2M7.5 17h2M11 17h2" /></>,
  more: <><circle cx="5.5" cy="12" r="1.7" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none" /><circle cx="18.5" cy="12" r="1.7" fill="currentColor" stroke="none" /></>,
  note: <><path d="M6 3.5h8.5L19 8v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19V5A1.5 1.5 0 0 1 6.5 3.5Z" /><path d="M14 3.5V8.5h5M8.5 12.5h7M8.5 16h5" /></>,
  heart: <path d="M12 19.5s-7.5-4.4-7.5-10A4.2 4.2 0 0 1 12 7a4.2 4.2 0 0 1 7.5 2.5c0 5.6-7.5 10-7.5 10Z" />,
  trash: <><path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.9 12.2a1.5 1.5 0 0 0 1.5 1.3h6.2a1.5 1.5 0 0 0 1.5-1.3L17.5 7" /><path d="M10 11v6M14 11v6" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  chevronRight: <path d="m9.5 5.5 6.5 6.5-6.5 6.5" />,
  chevronLeft: <path d="m14.5 5.5-6.5 6.5 6.5 6.5" />,
  search: <><circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 5 5" /></>,
  lock: <><rect x="5" y="10.5" width="14" height="10" rx="2.5" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /></>,
  people: <><circle cx="9" cy="8.5" r="3.2" /><path d="M3.5 19.5c.4-3.3 2.6-5.2 5.5-5.2s5.1 1.9 5.5 5.2" /><circle cx="16.5" cy="9.5" r="2.6" /><path d="M15.6 14.4c2.6 0 4.5 1.7 4.9 4.6" /></>,
  cloud: <path d="M7 18.5h10a4 4 0 0 0 .6-8 5.5 5.5 0 0 0-10.6 1.4A3.3 3.3 0 0 0 7 18.5Z" />,
  cloudOff: <><path d="M7 18.5h10a4 4 0 0 0 .6-8 5.5 5.5 0 0 0-10.6 1.4A3.3 3.3 0 0 0 7 18.5Z" /><path d="m4 4 16 16" /></>,
  alert: <><path d="M12 4 21 19.5H3Z" /><path d="M12 10v4.5" /><circle cx="12" cy="17" r=".9" fill="currentColor" stroke="none" /></>,
  share: <><path d="M12 3.5v11M8 7.5l4-4 4 4" /><path d="M7 11H6a1.5 1.5 0 0 0-1.5 1.5v6.5A1.5 1.5 0 0 0 6 20.5h12a1.5 1.5 0 0 0 1.5-1.5v-6.5A1.5 1.5 0 0 0 18 11h-1" /></>,
  addSquare: <><rect x="4" y="4" width="16" height="16" rx="3.5" /><path d="M12 8.5v7M8.5 12h7" /></>,
  eye: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="3" /></>,
  eyeOff: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="3" /><path d="m4 4 16 16" /></>,
  check: <path d="m5.5 12.5 4.2 4.2L18.5 7.5" />,
  key: <><circle cx="8" cy="15" r="4" /><path d="m11 12 8.5-8.5M16 7l2.5 2.5M14 9l2 2" /></>,
  logout: <><path d="M14 4.5H7A1.5 1.5 0 0 0 5.5 6v12A1.5 1.5 0 0 0 7 19.5h7" /><path d="M10.5 12h10M17 8.5l3.5 3.5-3.5 3.5" /></>,
  bell: <><path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 2h-14Z" /><path d="M10 20.5h4" /></>,
  download: <><path d="M12 4v11M8 11l4 4 4-4" /><path d="M5 19.5h14" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  palette: <><path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.2 0 1.7-.8 1.4-1.8-.4-1.2.3-2.2 1.5-2.2H17a3.5 3.5 0 0 0 3.5-3.5c0-5.2-3.8-9.5-8.5-9.5Z" /><circle cx="8" cy="11" r="1.1" fill="currentColor" stroke="none" /><circle cx="11.5" cy="7.8" r="1.1" fill="currentColor" stroke="none" /><circle cx="15.5" cy="9" r="1.1" fill="currentColor" stroke="none" /></>,
  edit: <><path d="M5 19l1-4.2L15.8 5a1.8 1.8 0 0 1 2.6 0l.6.6a1.8 1.8 0 0 1 0 2.6L9.2 18Z" /><path d="M13.8 7l3.2 3.2M4.5 20.5h15" /></>,
  phone: <><rect x="7" y="2.5" width="10" height="19" rx="2.5" /><path d="M10.5 18.5h3" /></>,
} satisfies Record<string, ReactElement>;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 24 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {paths[name]}
    </svg>
  );
}

/** Razem mark: two overlapping rounded shapes (own design, not a third-party logo). */
export function BrandMark({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false" className="brand-mark">
      <rect width="64" height="64" rx="15" fill="var(--accent)" />
      <circle cx="25" cy="32" r="12" fill="none" stroke="#fff" strokeWidth="5" />
      <circle cx="39" cy="32" r="12" fill="none" stroke="#fff" strokeWidth="5" opacity=".8" />
    </svg>
  );
}
