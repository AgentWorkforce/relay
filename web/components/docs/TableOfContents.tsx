'use client';

import { useEffect, useState } from 'react';

import type { TocItem } from '../../lib/docs';
import styles from './docs.module.css';

export function TableOfContents({ items }: { items: TocItem[] }) {
  const [activeId, setActiveId] = useState('');

  useEffect(() => {
    const headings = items
      .map((item) => document.getElementById(item.id))
      .filter(Boolean) as HTMLElement[];

    if (headings.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
          }
        }
      },
      { rootMargin: '-80px 0px -60% 0px', threshold: 0 }
    );

    for (const el of headings) observer.observe(el);
    return () => observer.disconnect();
  }, [items]);

  if (items.length === 0) return null;

  return (
    <nav className={styles.toc} aria-label="On this page">
      <h4 className={styles.tocTitle}>On this page</h4>
      <ul className={styles.tocList}>
        {items.map((item) => (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              className={`${styles.tocLink} ${item.level === 3 ? styles.tocIndent : ''} ${activeId === item.id ? styles.tocActive : ''}`}
            >
              {item.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
