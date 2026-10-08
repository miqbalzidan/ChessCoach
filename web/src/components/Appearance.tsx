import { useState } from 'react';
import {
  DEFAULT_APPEARANCE,
  FONT_ROLES,
  FONTS,
  TEXT_SIZES,
  type Appearance as Choices,
  type FontRole,
  type ThemeChoice,
} from '../appearance';
import { extraFontsAvailable, loadAppearance, saveAppearance } from '../appearance-store';

const THEMES: Array<{ id: ThemeChoice; label: string }> = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

/**
 * Theme, typefaces and text size, for this device.
 *
 * Every change applies the moment it is made — the page you are looking at is the
 * preview — and each typeface is shown in itself, because a font cannot be chosen
 * from its name. Showing them is also what fetches them, once; after that the
 * offline cache keeps whichever were seen.
 */
export function Appearance() {
  const [choices, setChoices] = useState<Choices>(loadAppearance);
  const offerExtra = extraFontsAvailable();

  const change = (next: Partial<Choices>) => {
    const updated = { ...choices, ...next };
    setChoices(updated);
    saveAppearance(updated);
  };

  const isDefault = (Object.keys(DEFAULT_APPEARANCE) as Array<keyof Choices>).every(
    (key) => choices[key] === DEFAULT_APPEARANCE[key],
  );

  return (
    <section className="appearance" aria-label="Appearance">
      <div className="section-head">
        <div className="label">appearance</div>
      </div>

      <div className="band appearance-band" role="group" aria-label="Theme">
        <span className="band-label">theme</span>
        {THEMES.map((theme) => (
          <button
            key={theme.id}
            type="button"
            className={`band-option${choices.theme === theme.id ? ' is-active' : ''}`}
            aria-pressed={choices.theme === theme.id}
            onClick={() => change({ theme: theme.id })}
          >
            {theme.label}
          </button>
        ))}
      </div>

      <div className="band appearance-band" role="group" aria-label="Text size">
        <span className="band-label">text size</span>
        {TEXT_SIZES.map((size) => (
          <button
            key={size.id}
            type="button"
            className={`band-option${choices.size === size.id ? ' is-active' : ''}`}
            aria-pressed={choices.size === size.id}
            onClick={() => change({ size: size.id })}
          >
            {/* Each label is set at the size it chooses, so the row is its own scale. */}
            <span style={{ fontSize: `${size.scale}em` }}>{size.label}</span>
          </button>
        ))}
      </div>

      <div className="appearance-fonts">
        {FONT_ROLES.map(({ role, label, sample }) => (
          <FontPicker
            key={role}
            role={role}
            label={label}
            sample={sample}
            selected={choices[role]}
            offerExtra={offerExtra}
            onPick={(id) => change({ [role]: id } as Partial<Choices>)}
          />
        ))}

        <div className="appearance-foot">
          <span className="meta">
            Saved on this device only.
            {offerExtra ? '' : ' This file carries the designed typefaces; the others are in the app.'}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={isDefault}
            onClick={() => change(DEFAULT_APPEARANCE)}
          >
            back to the designed look
          </button>
        </div>
      </div>
    </section>
  );
}

function FontPicker({
  role,
  label,
  sample,
  selected,
  offerExtra,
  onPick,
}: {
  role: FontRole;
  label: string;
  sample: string;
  selected: string;
  offerExtra: boolean;
  onPick: (id: string) => void;
}) {
  // A choice made where the extra faces exist stays visible in a file without them,
  // so the picker never shows nothing selected.
  const options = FONTS[role].filter((option) => offerExtra || !option.extra || option.id === selected);

  return (
    <div className="font-role" role="group" aria-label={label}>
      <div className="label-sm font-role-label">{label}</div>
      <div className="font-options">
        {options.map((option) => {
          const active = option.id === selected;
          return (
            <button
              key={option.id}
              type="button"
              className={`font-option${active ? ' is-active' : ''}`}
              aria-pressed={active}
              onClick={() => onPick(option.id)}
            >
              <span className={`font-option-sample font-sample-${role}`} style={{ fontFamily: option.stack }}>
                {sample}
              </span>
              <span className="font-option-name">
                {option.label}
                {active ? <span className="font-option-tick"> · in use</span> : null}
              </span>
              <span className="font-option-note">{option.note}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
