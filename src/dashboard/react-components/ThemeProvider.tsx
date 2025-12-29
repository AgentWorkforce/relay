/**
 * ThemeProvider Component
 *
 * Provides theme context for light/dark mode support.
 * Handles system preference detection and persistence.
 */

import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';

export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export interface ThemeProviderProps {
  children: React.ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
}

export function ThemeProvider({
  children,
  defaultTheme = 'system',
  storageKey = 'dashboard-theme',
}: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(() => {
    // Try to get from storage
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem(storageKey);
      if (stored === 'light' || stored === 'dark' || stored === 'system') {
        return stored;
      }
    }
    return defaultTheme;
  });

  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() => {
    if (typeof window !== 'undefined') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return 'light';
  });

  // Listen for system theme changes
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (e: MediaQueryListEvent) => {
      setSystemTheme(e.matches ? 'dark' : 'light');
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  // Resolve theme
  const resolvedTheme: ResolvedTheme = theme === 'system' ? systemTheme : theme;

  // Apply theme to document
  useEffect(() => {
    if (typeof document === 'undefined') return;

    const root = document.documentElement;
    root.classList.remove('theme-light', 'theme-dark');
    root.classList.add(`theme-${resolvedTheme}`);
    root.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);

  // Set theme with persistence
  const setTheme = useCallback(
    (newTheme: Theme) => {
      setThemeState(newTheme);
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(storageKey, newTheme);
      }
    },
    [storageKey]
  );

  // Toggle between light and dark
  const toggleTheme = useCallback(() => {
    setTheme(resolvedTheme === 'light' ? 'dark' : 'light');
  }, [resolvedTheme, setTheme]);

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme, toggleTheme }),
    [theme, resolvedTheme, setTheme, toggleTheme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}

/**
 * CSS variables for theming
 * Include these in your global styles
 */
export const themeStyles = `
/* Light Theme (Default) */
:root,
.theme-light {
  /* Backgrounds */
  --bg-primary: #f5f5f5;
  --bg-secondary: #ffffff;
  --bg-tertiary: #fafafa;
  --bg-hover: #f0f0f0;
  --bg-active: #e8e8e8;
  --bg-elevated: #ffffff;
  --bg-overlay: rgba(0, 0, 0, 0.5);

  /* Text */
  --text-primary: #1a1a1a;
  --text-secondary: #666666;
  --text-muted: #888888;
  --text-inverse: #ffffff;

  /* Borders */
  --border-default: #e8e8e8;
  --border-light: #f0f0f0;
  --border-dark: #d0d0d0;

  /* Accent */
  --accent-primary: #1264a3;
  --accent-hover: #0d4f82;
  --accent-light: #e8f4fd;

  /* Status */
  --status-success: #10b981;
  --status-success-light: #dcfce7;
  --status-warning: #f59e0b;
  --status-warning-light: #fef3c7;
  --status-error: #ef4444;
  --status-error-light: #fee2e2;
  --status-info: #3b82f6;
  --status-info-light: #dbeafe;

  /* Shadows */
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.05);
  --shadow-md: 0 1px 3px rgba(0, 0, 0, 0.1);
  --shadow-lg: 0 4px 6px rgba(0, 0, 0, 0.1);
  --shadow-xl: 0 10px 15px rgba(0, 0, 0, 0.1);

  /* Scrollbar */
  --scrollbar-track: transparent;
  --scrollbar-thumb: #d0d0d0;
  --scrollbar-thumb-hover: #888888;
}

/* Dark Theme */
.theme-dark {
  /* Backgrounds */
  --bg-primary: #1a1a1a;
  --bg-secondary: #252525;
  --bg-tertiary: #2a2a2a;
  --bg-hover: #333333;
  --bg-active: #3a3a3a;
  --bg-elevated: #2f2f2f;
  --bg-overlay: rgba(0, 0, 0, 0.7);

  /* Text */
  --text-primary: #f0f0f0;
  --text-secondary: #a0a0a0;
  --text-muted: #707070;
  --text-inverse: #1a1a1a;

  /* Borders */
  --border-default: #3a3a3a;
  --border-light: #333333;
  --border-dark: #4a4a4a;

  /* Accent */
  --accent-primary: #4a9eda;
  --accent-hover: #6bb3e8;
  --accent-light: #1e3a5f;

  /* Status */
  --status-success: #34d399;
  --status-success-light: #064e3b;
  --status-warning: #fbbf24;
  --status-warning-light: #78350f;
  --status-error: #f87171;
  --status-error-light: #7f1d1d;
  --status-info: #60a5fa;
  --status-info-light: #1e3a8a;

  /* Shadows */
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.3);
  --shadow-md: 0 1px 3px rgba(0, 0, 0, 0.4);
  --shadow-lg: 0 4px 6px rgba(0, 0, 0, 0.4);
  --shadow-xl: 0 10px 15px rgba(0, 0, 0, 0.5);

  /* Scrollbar */
  --scrollbar-track: #2a2a2a;
  --scrollbar-thumb: #4a4a4a;
  --scrollbar-thumb-hover: #5a5a5a;
}

/* Apply theme variables */
body {
  background: var(--bg-primary);
  color: var(--text-primary);
}

/* Scrollbar theming */
::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

::-webkit-scrollbar-track {
  background: var(--scrollbar-track);
}

::-webkit-scrollbar-thumb {
  background: var(--scrollbar-thumb);
  border-radius: 4px;
}

::-webkit-scrollbar-thumb:hover {
  background: var(--scrollbar-thumb-hover);
}

/* Selection theming */
::selection {
  background: var(--accent-light);
  color: var(--accent-primary);
}

/* Transition for theme changes */
html.theme-transitioning,
html.theme-transitioning *,
html.theme-transitioning *::before,
html.theme-transitioning *::after {
  transition: background-color 0.3s ease, border-color 0.3s ease, color 0.15s ease !important;
}
`;

/**
 * ThemeToggle Component
 * A simple button to toggle between themes
 */
export interface ThemeToggleProps {
  showLabel?: boolean;
  className?: string;
}

export function ThemeToggle({ showLabel = false, className = '' }: ThemeToggleProps) {
  const { resolvedTheme, toggleTheme } = useTheme();

  return (
    <button
      className={`theme-toggle ${className}`}
      onClick={toggleTheme}
      aria-label={`Switch to ${resolvedTheme === 'light' ? 'dark' : 'light'} mode`}
    >
      {resolvedTheme === 'light' ? <MoonIcon /> : <SunIcon />}
      {showLabel && <span>{resolvedTheme === 'light' ? 'Dark' : 'Light'} mode</span>}
    </button>
  );
}

function SunIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

export const themeToggleStyles = `
.theme-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  color: var(--text-secondary);
  cursor: pointer;
  font-family: inherit;
  font-size: 13px;
  transition: all 0.15s;
}

.theme-toggle:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.theme-toggle svg {
  flex-shrink: 0;
}
`;
