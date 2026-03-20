'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';

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
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const results = search(query, index);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setActiveIdx(0);
  }, []);

  const navigate = useCallback((slug: string) => {
    close();
    router.push(`/docs/${slug}`);
  }, [close, router]);

  // Reset active index when results change
  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

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

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((prev) => (prev + 1) % Math.max(results.length, 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((prev) => (prev - 1 + results.length) % Math.max(results.length, 1));
    } else if (e.key === 'Enter' && results[activeIdx]) {
      e.preventDefault();
      navigate(results[activeIdx].slug);
    }
  }

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

      {open && createPortal(
        <div className={s.overlay} onClick={close}>
          <div className={s.modal} onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
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
                  results.map((entry, i) => (
                    <a
                      key={entry.slug}
                      href={`/docs/${entry.slug}`}
                      className={`${s.result} ${i === activeIdx ? s.resultActive : ''}`}
                      onClick={(e) => { e.preventDefault(); navigate(entry.slug); }}
                      onMouseEnter={() => setActiveIdx(i)}
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
        </div>,
        document.body
      )}
    </>
  );
}
