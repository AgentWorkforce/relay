'use client';

import {
  createContext,
  startTransition,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

export type DocsLanguage = 'typescript' | 'python';

type DocsLanguageContextValue = {
  language: DocsLanguage;
  setLanguage: (language: DocsLanguage) => void;
};

const STORAGE_KEY = 'agent-relay-docs-language';

const DocsLanguageContext = createContext<DocsLanguageContextValue | null>(null);

export function normalizeDocsLanguageLabel(label: string): DocsLanguage | null {
  const normalized = label.trim().toLowerCase();

  if (normalized === 'typescript' || normalized === 'ts' || normalized === 'tsx') {
    return 'typescript';
  }

  if (normalized === 'python' || normalized === 'py') {
    return 'python';
  }

  return null;
}

export function DocsLanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<DocsLanguage>('typescript');

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'typescript' || stored === 'python') {
      setLanguageState(stored);
    }
  }, []);

  function setLanguage(nextLanguage: DocsLanguage) {
    window.localStorage.setItem(STORAGE_KEY, nextLanguage);
    startTransition(() => {
      setLanguageState(nextLanguage);
    });
  }

  return (
    <DocsLanguageContext.Provider value={{ language, setLanguage }}>
      {children}
    </DocsLanguageContext.Provider>
  );
}

export function useDocsLanguage() {
  const context = useContext(DocsLanguageContext);

  if (!context) {
    throw new Error('useDocsLanguage must be used within DocsLanguageProvider');
  }

  return context;
}
