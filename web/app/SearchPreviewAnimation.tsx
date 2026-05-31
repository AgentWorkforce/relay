'use client';

import { useEffect, useState } from 'react';

import s from './landing.module.css';

const SEARCH_QUERY = 'handoff token';

const RESULTS = [
  {
    label: '#dev',
    time: '4m ago',
    before: 'Builder shared the ',
    match: 'handoff token',
    after: ' in the release handoff thread',
  },
  {
    label: '@reviewer',
    time: '8m ago',
    before: 'Reviewer referenced the same ',
    match: 'handoff token',
    after: ' during deploy review',
  },
  {
    label: '#ops',
    time: '12m ago',
    before: 'Deployment note links the token to the final rollout checklist',
    match: '',
    after: '',
  },
];

function visibleResultCount(length: number) {
  if (length >= SEARCH_QUERY.length) return RESULTS.length;
  if (length >= 8) return 2;
  if (length >= 4) return 1;
  return 0;
}

export function SearchPreviewAnimation() {
  const [typedLength, setTypedLength] = useState(0);

  useEffect(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (reducedMotion) {
      setTypedLength(SEARCH_QUERY.length);
      return;
    }

    let active = true;
    let timeoutId: number | undefined;

    const tick = (nextLength: number) => {
      const atEnd = nextLength >= SEARCH_QUERY.length;
      const delay = atEnd ? 2200 : nextLength === 0 ? 650 : 105;

      timeoutId = window.setTimeout(() => {
        if (!active) return;

        const next = atEnd ? 0 : nextLength + 1;
        setTypedLength(next);
        tick(next);
      }, delay);
    };

    setTypedLength(0);
    tick(0);

    return () => {
      active = false;
      window.clearTimeout(timeoutId);
    };
  }, []);

  const query = SEARCH_QUERY.slice(0, typedLength);
  const resultCount = visibleResultCount(typedLength);

  return (
    <div className={s.searchPreview}>
      <div className={s.searchBar}>
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="2" />
          <path d="m16 16 4 4" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
        </svg>
        <span className={s.searchQuery}>
          {query}
          <span className={s.searchCursor} aria-hidden="true" />
        </span>
      </div>
      <div className={s.searchResults}>
        {RESULTS.map((result, index) => (
          <div
            key={result.label}
            className={index < resultCount ? s.searchResultVisible : s.searchResultHidden}
            style={{ transitionDelay: `${Math.min(index * 90, 180)}ms` }}
          >
            <strong>
              <span>{result.label}</span>
              <time>{result.time}</time>
            </strong>
            <span>
              {result.before}
              {result.match && <mark>{result.match}</mark>}
              {result.after}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
