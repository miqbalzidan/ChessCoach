/**
 * Reading, saving and applying an appearance — the half of it that needs a browser.
 * What the choices are and what they mean in CSS is in `appearance.ts`.
 */
import { cssFor, DEFAULT_APPEARANCE, sanitise, STORAGE_KEY, type Appearance } from './appearance';

export function loadAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? sanitise(JSON.parse(raw) as Partial<Appearance>) : DEFAULT_APPEARANCE;
  } catch {
    // Storage refused (a private window, blocked site data) or unreadable: the
    // designed defaults, which is what the page shows without any of this.
    return DEFAULT_APPEARANCE;
  }
}

/** Applies a set of choices now, and keeps them for next time where storage allows. */
export function saveAppearance(appearance: Appearance): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...appearance, css: cssFor(appearance) }));
  } catch {
    // Still applied for this visit; it just will not be remembered.
  }
  applyAppearance(appearance);
}

declare global {
  interface Window {
    /** Defined by the boot script in index.html: re-resolves the theme. */
    __leaksheetApplyTheme?: () => void;
  }
}

export function applyAppearance(appearance: Appearance): void {
  const root = document.documentElement;
  for (const [property, value] of Object.entries(cssFor(appearance))) {
    root.style.setProperty(property, value);
  }
  root.setAttribute('data-theme-choice', appearance.theme);

  if (window.__leaksheetApplyTheme) {
    window.__leaksheetApplyTheme();
    return;
  }
  // A page without the boot script — an export made before it existed — still
  // switches; it just will not follow the system while it stays open.
  const dark =
    appearance.theme === 'dark' ||
    (appearance.theme === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  root.setAttribute('data-theme', dark ? 'dark' : 'light');
}

/**
 * Whether the extra typefaces can be offered here. Exports leave their stylesheet
 * out, so an exported file offers the bundled faces and the system ones — choosing a
 * font that would silently fall back to another is worse than not seeing it.
 */
export function extraFontsAvailable(): boolean {
  return document.querySelector('link[data-fonts="extra"]') !== null;
}
