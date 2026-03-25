'use client';

import { useEffect, useState } from 'react';

import s from './theme-toggle.module.css';

type Theme = 'light' | 'dark';

const STORAGE_KEY = 'agentrelay-theme';

function readTheme(): Theme {
  if (document.documentElement.dataset.theme === 'dark') {
    return 'dark';
  }

  if (document.documentElement.dataset.theme === 'light') {
    return 'light';
  }

  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  localStorage.setItem(STORAGE_KEY, theme);
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2.5M12 19.5V22M4.93 4.93l1.77 1.77M17.3 17.3l1.77 1.77M2 12h2.5M19.5 12H22M4.93 19.07l1.77-1.77M17.3 6.7l1.77-1.77" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7.2 7.2 0 0 0 9.8 9.8Z" />
    </svg>
  );
}

export function ThemeToggle({ mobile = false }: { mobile?: boolean } = {}) {
  const [mounted, setMounted] = useState(false);
  const [theme, setTheme] = useState<Theme>('light');

  useEffect(() => {
    setTheme(readTheme());
    setMounted(true);

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (localStorage.getItem(STORAGE_KEY)) {
        return;
      }

      document.documentElement.removeAttribute('data-theme');
      document.documentElement.style.removeProperty('color-scheme');
      setTheme(media.matches ? 'dark' : 'light');
    };

    media.addEventListener?.('change', onChange);
    return () => media.removeEventListener?.('change', onChange);
  }, []);

  const nextTheme: Theme = theme === 'dark' ? 'light' : 'dark';
  const actionLabel = mounted
    ? `Switch to ${nextTheme} mode`
    : 'Toggle color theme';

  return (
    <button
      type="button"
      className={`${s.button} ${mobile ? s.mobile : ''}`}
      onClick={() => {
        applyTheme(nextTheme);
        setTheme(nextTheme);
      }}
      aria-label={actionLabel}
      title={actionLabel}
    >
      <span className={s.icon}>
        {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
      </span>
      {mobile && <span className={s.label}>{nextTheme === 'dark' ? 'Dark mode' : 'Light mode'}</span>}
    </button>
  );
}
