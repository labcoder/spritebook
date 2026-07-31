/**
 * UiLayoutPrefs — machine-local, never part of any manifest (design-system:
 * "Panel state persists in machine-local UiLayoutPrefs"). localStorage with
 * per-key fallbacks; storage being unavailable degrades to per-session state.
 */

const KEYS = {
  theme: 'sb-theme',
  locale: 'sb-locale',
  projectsRoot: 'sb-projects-root',
  inspectorWidth: 'sb-inspector-w',
} as const;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // per-session only
  }
}

export const prefs = {
  theme(): 'dark' | 'light' {
    const t = read(KEYS.theme);
    return t === 'light' ? 'light' : 'dark';
  },
  setTheme(t: 'dark' | 'light'): void {
    write(KEYS.theme, t);
  },
  locale(): 'en' | 'es' | 'pseudo' {
    const l = read(KEYS.locale);
    return l === 'pseudo' || l === 'es' ? l : 'en';
  },
  setLocale(l: 'en' | 'es' | 'pseudo'): void {
    write(KEYS.locale, l);
  },
  projectsRoot(fallback: string): string {
    return read(KEYS.projectsRoot) ?? fallback;
  },
  setProjectsRoot(r: string): void {
    write(KEYS.projectsRoot, r);
  },
  inspectorWidth(fallback: number, min: number, max: number): number {
    const n = Number(read(KEYS.inspectorWidth));
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  },
  setInspectorWidth(w: number): void {
    write(KEYS.inspectorWidth, String(Math.round(w)));
  },
};
