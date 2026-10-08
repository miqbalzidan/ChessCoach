/**
 * How the sheet looks on this device: the theme, the typefaces and the text size.
 *
 * A per-device preference, so it lives in this browser's storage rather than in the
 * games database — your phone can be dark and your laptop light, and an exported
 * sheet opens in whatever its reader has chosen, not what its writer had.
 *
 * Three parts. This module is the source of truth: the choices and what each one
 * means in CSS — pure, so it can be tested without a browser. `appearance-store.ts`
 * reads, saves and applies them. The boot script in index.html is the third, and it
 * runs before the first paint — otherwise a dark sheet would open bone-white for the
 * moment it takes the bundle to load. It knows nothing about fonts or sizes; it
 * applies the `css` this module stored beside the choices, and resolves the theme.
 */

export type ThemeChoice = 'system' | 'light' | 'dark';
export type FontRole = 'display' | 'ui' | 'prose' | 'mono';

export interface FontOption {
  id: string;
  label: string;
  /** What it is, in a few words, for the picker. */
  note: string;
  /** The font-family stack. Every one ends in its role's bundled face and then a
   *  system family, so a file without the extra fonts still looks designed. */
  stack: string;
  /** Served from fonts/extra: fetched the first time it is chosen, and left out of
   *  exported files to keep them small. */
  extra?: boolean;
}

const BODONI = "'Bodoni Moda', 'Didot', Georgia, 'Times New Roman', serif";
const PLEX_SANS = "'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const SPECTRAL = "'Spectral', Georgia, 'Times New Roman', serif";
const PLEX_MONO = "'IBM Plex Mono', ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace";

export const FONTS: Record<FontRole, FontOption[]> = {
  display: [
    {
      id: 'bodoni',
      label: 'Bodoni Moda',
      note: 'the original — a high-contrast didone',
      stack: "'Bodoni Moda', 'Didot', 'Playfair Display', Georgia, 'Times New Roman', serif",
    },
    { id: 'playfair', label: 'Playfair Display', note: 'a softer high-contrast serif', stack: `'Playfair Display', ${BODONI}`, extra: true },
    { id: 'fraunces', label: 'Fraunces', note: 'warm and a little wonky', stack: `'Fraunces', ${BODONI}`, extra: true },
    { id: 'space-grotesk', label: 'Space Grotesk', note: 'a geometric sans', stack: `'Space Grotesk', ${PLEX_SANS}`, extra: true },
    { id: 'system', label: 'System serif', note: "this device's own", stack: "Georgia, 'Times New Roman', serif" },
  ],
  ui: [
    { id: 'plex-sans', label: 'IBM Plex Sans', note: 'the original', stack: PLEX_SANS },
    { id: 'inter', label: 'Inter', note: 'neutral, made for screens', stack: `'Inter', ${PLEX_SANS}`, extra: true },
    {
      id: 'atkinson',
      label: 'Atkinson Hyperlegible',
      note: 'drawn for low vision — no two letters alike',
      stack: `'Atkinson Hyperlegible', ${PLEX_SANS}`,
      extra: true,
    },
    { id: 'system', label: 'System sans', note: "this device's own", stack: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" },
  ],
  prose: [
    { id: 'spectral', label: 'Spectral', note: 'the original', stack: SPECTRAL },
    { id: 'literata', label: 'Literata', note: 'made for long reading on screens', stack: `'Literata', ${SPECTRAL}`, extra: true },
    { id: 'source-serif', label: 'Source Serif 4', note: 'a sturdy text serif', stack: `'Source Serif 4', ${SPECTRAL}`, extra: true },
    {
      id: 'atkinson',
      label: 'Atkinson Hyperlegible',
      note: 'a sans, for the plainest reading',
      stack: `'Atkinson Hyperlegible', ${PLEX_SANS}`,
      extra: true,
    },
    { id: 'system', label: 'System serif', note: "this device's own", stack: "Georgia, 'Times New Roman', serif" },
  ],
  mono: [
    { id: 'plex-mono', label: 'IBM Plex Mono', note: 'the original', stack: PLEX_MONO },
    { id: 'jetbrains', label: 'JetBrains Mono', note: 'taller, rounder figures', stack: `'JetBrains Mono', ${PLEX_MONO}`, extra: true },
    { id: 'system', label: 'System mono', note: "this device's own", stack: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace" },
  ],
};

/** What each role sets, in the words the picker uses. */
export const FONT_ROLES: Array<{ role: FontRole; label: string; sample: string }> = [
  { role: 'display', label: 'Headlines and numbers', sample: '70.2' },
  { role: 'ui', label: 'Interface', sample: 'Blunder · 3 games' },
  { role: 'prose', label: 'Reading', sample: 'You let the advantage slip with two slow king moves.' },
  { role: 'mono', label: 'Chess notation', sample: '24. Nd5 Bf3' },
];

/**
 * Text size scales type only. The board, the graph and the layout keep their size:
 * a bigger board is the browser's zoom, which is already there, and what is hard to
 * read on a phone is the nine-pixel labels, not the pieces.
 */
export const TEXT_SIZES = [
  { id: 'small', label: 'Small', scale: 0.92 },
  { id: 'default', label: 'Default', scale: 1 },
  { id: 'large', label: 'Large', scale: 1.12 },
  { id: 'larger', label: 'Larger', scale: 1.25 },
] as const;

export interface Appearance {
  theme: ThemeChoice;
  display: string;
  ui: string;
  prose: string;
  mono: string;
  size: string;
}

export const DEFAULT_APPEARANCE: Appearance = {
  theme: 'system',
  display: 'bodoni',
  ui: 'plex-sans',
  prose: 'spectral',
  mono: 'plex-mono',
  size: 'default',
};

/** Read by the boot script in index.html too, so it is spelled out there as well. */
export const STORAGE_KEY = 'chesscoach.appearance';
const THEMES: ThemeChoice[] = ['system', 'light', 'dark'];

/** Anything unrecognised — an option since removed, a hand-edited value — falls back
 *  to the default for that setting alone, rather than discarding all of them. */
export function sanitise(value: Partial<Record<keyof Appearance, unknown>>): Appearance {
  const pick = (role: FontRole) =>
    FONTS[role].some((option) => option.id === value[role]) ? (value[role] as string) : DEFAULT_APPEARANCE[role];
  return {
    theme: THEMES.includes(value.theme as ThemeChoice) ? (value.theme as ThemeChoice) : DEFAULT_APPEARANCE.theme,
    display: pick('display'),
    ui: pick('ui'),
    prose: pick('prose'),
    mono: pick('mono'),
    size: TEXT_SIZES.some((size) => size.id === value.size) ? (value.size as string) : DEFAULT_APPEARANCE.size,
  };
}

export function fontOption(role: FontRole, id: string): FontOption {
  return FONTS[role].find((option) => option.id === id) ?? FONTS[role][0]!;
}

/** The custom properties a set of choices comes to. The boot script applies these. */
export function cssFor(appearance: Appearance): Record<string, string> {
  const size = TEXT_SIZES.find((entry) => entry.id === appearance.size) ?? TEXT_SIZES[1];
  return {
    '--display': fontOption('display', appearance.display).stack,
    '--ui': fontOption('ui', appearance.ui).stack,
    '--prose': fontOption('prose', appearance.prose).stack,
    '--mono': fontOption('mono', appearance.mono).stack,
    '--text-scale': String(size.scale),
  };
}
