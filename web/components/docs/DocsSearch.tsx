'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { SearchEntry } from '../../lib/docs';
import s from './docs-search.module.css';

interface DocsSearchProps {
  index: SearchEntry[];
}

function search(query: string, index: SearchEntry[]): SearchEntry[] {
  if (!query.trim()) return [];
  const q = query.toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);

  return index
    .map((entry) => {
      const haystack = `${entry.title} ${entry.description} ${entry.headings.join(' ')} ${entry.body}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (entry.title.toLowerCase().includes(term)) score += 10;
        if (entry.description.toLowerCase().includes(term)) score += 5;
        if (entry.headings.some((h) => h.toLowerCase().includes(term))) score += 3;
        if (haystack.includes(term)) score += 1;
      }
      return { entry, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((r) => r.entry);
}

export function DocsSearch({ index }: DocsSearchProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const results = search(query, index);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
  }, []);

  // Cmd+K / Ctrl+K shortcut
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
      if (e.key === 'Escape') close();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [close]);

  // Focus input when modal opens
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  return (
    <>
      <button className={s.trigger} onClick={() => setOpen(true)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <span className={s.triggerText}>Search docs...</span>
        <kbd className={s.triggerKbd}>&#8984;K</kbd>
      </button>

      {open && (
        <div className={s.overlay} onClick={close}>
          <div className={s.modal} onClick={(e) => e.stopPropagation()}>
            <div className={s.inputRow}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                ref={inputRef}
                className={s.input}
                placeholder="Search documentation..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <kbd className={s.escKbd} onClick={close}>Esc</kbd>
            </div>

            {query.trim() && (
              <div className={s.results}>
                {results.length === 0 ? (
                  <p className={s.empty}>No results for &ldquo;{query}&rdquo;</p>
                ) : (
                  results.map((entry) => (
                    <a
                      key={entry.slug}
                      href={`/docs/${entry.slug}`}
                      className={s.result}
                      onClick={close}
                    >
                      <span className={s.resultTitle}>{entry.title}</span>
                      {entry.description && (
                        <span className={s.resultDesc}>{entry.description}</span>
                      )}
                    </a>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
