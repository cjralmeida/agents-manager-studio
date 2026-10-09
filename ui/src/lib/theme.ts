import type { Theme } from '../api/auth';

const STORAGE_KEY = 'ams.theme';

/**
 * Applies the theme to the page: "light"/"dark" pin it, "system" leaves it to the OS (no data-theme). It is also
 * remembered in this browser so index.html can apply it before the first paint.
 */
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Preference only.
  }
}

export const themeLabels: Record<Theme, string> = { system: 'Sistema', light: 'Claro', dark: 'Escuro' };
