import { useSyncExternalStore } from 'react';

export type StudioTheme = 'dark' | 'light';
const key = 'opencut.studio-theme';
const changed = 'opencut:theme-changed';

function current(): StudioTheme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function applyStudioTheme(theme: StudioTheme): void {
  if (document.documentElement.dataset.theme === theme) return;
  document.documentElement.dataset.theme = theme;
  window.dispatchEvent(new Event(changed));
}

// settings.json is authoritative across desktop launches, even if the local server changes port.
// This origin-local copy supplies the first frame and updates the other open project views.
export function rememberStudioTheme(theme: StudioTheme): void {
  applyStudioTheme(theme);
  try { localStorage.setItem(key, theme); } catch { /* An isolated view can still use the settings file. */ }
}

export function initializeStudioTheme(): void {
  let theme: StudioTheme = 'dark';
  try { if (localStorage.getItem(key) === 'light') theme = 'light'; } catch { /* Use the default until settings load. */ }
  applyStudioTheme(theme);
  window.addEventListener('storage', (event) => {
    if (event.key === key) applyStudioTheme(event.newValue === 'light' ? 'light' : 'dark');
  });
}

function subscribe(listener: () => void): () => void {
  window.addEventListener(changed, listener);
  return () => window.removeEventListener(changed, listener);
}

export function useStudioTheme(): StudioTheme {
  return useSyncExternalStore(subscribe, current);
}
