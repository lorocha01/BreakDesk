import type { Settings } from './net/protocol';

let mql: MediaQueryList | null = null;
let current: Settings['theme'] = 'system';

function resolve(theme: Settings['theme']): 'light' | 'dark' {
  if (theme === 'system') return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  return theme;
}

export function applyTheme(theme: Settings['theme']): void {
  current = theme;
  const root = document.documentElement;
  root.dataset.theme = resolve(theme);
  root.style.colorScheme = root.dataset.theme;
  if (!mql) {
    mql = window.matchMedia('(prefers-color-scheme: dark)');
    mql.addEventListener('change', () => {
      if (current === 'system') applyTheme('system');
    });
  }
}
