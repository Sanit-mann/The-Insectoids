export type Theme = 'dark' | 'light';
const KEY = 'insectoids.theme';

/** Saved choice, else the system preference, else dark. Storage can be unavailable: never throw. */
export function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'dark' || saved === 'light') return saved;
  } catch {
    // storage unavailable: fall through
  }
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset['theme'] = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // storage unavailable: the theme still applies for this session
  }
}
