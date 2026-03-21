'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

export type Theme = 'light' | 'ocean' | 'carolina' | 'dark';

export const THEMES: { id: Theme; label: string; swatch: string }[] = [
  { id: 'light', label: 'Moss', swatch: '#2D4F3E' },
  { id: 'ocean', label: 'Ocean', swatch: '#264653' },
  { id: 'carolina', label: 'Carolina', swatch: '#4A90C2' },
  { id: 'dark', label: 'Dark', swatch: '#0c0f0e' },
];

const ThemeContext = createContext<{ theme: Theme; setTheme: (t: Theme) => void }>({
  theme: 'light',
  setTheme: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('carolina');

  useEffect(() => {
    const saved = localStorage.getItem('theme') as Theme | null;
    if (saved && THEMES.some((t) => t.id === saved)) {
      setThemeState(saved);
    }
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    localStorage.setItem('theme', next);
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
