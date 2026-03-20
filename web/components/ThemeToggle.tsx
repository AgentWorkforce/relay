'use client';

import { useState } from 'react';

import { THEMES, useTheme } from './ThemeProvider';
import s from './theme-toggle.module.css';

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);

  const current = THEMES.find((t) => t.id === theme) || THEMES[0];

  return (
    <div className={s.wrapper}>
      <button
        className={s.trigger}
        onClick={() => setOpen(!open)}
        aria-label="Change color scheme"
        title="Change color scheme"
      >
        <span className={s.swatch} style={{ background: current.swatch }} />
      </button>

      {open && (
        <>
          <div className={s.backdrop} onClick={() => setOpen(false)} />
          <div className={s.popover}>
            {THEMES.map((t) => (
              <button
                key={t.id}
                className={`${s.option} ${t.id === theme ? s.optionActive : ''}`}
                onClick={() => { setTheme(t.id); setOpen(false); }}
              >
                <span className={s.optionSwatch} style={{ background: t.swatch }} />
                <span className={s.optionLabel}>{t.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
