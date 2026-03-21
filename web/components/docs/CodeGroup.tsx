'use client';

import { useState, type ReactNode, type ReactElement, Children, isValidElement } from 'react';

import styles from './docs.module.css';

interface CodeGroupProps {
  children: ReactNode;
}

function getLabel(block: ReactElement, index: number): string {
  if (block.props['data-label']) {
    return block.props['data-label'] as string;
  }
  const code = Children.toArray(block.props.children).find(
    (c): c is ReactElement => isValidElement(c) && c.type === 'code'
  );
  if (!code) return `Tab ${index + 1}`;
  const className = code.props.className || '';
  const match = className.match(/language-(\S+)/);
  return match ? match[1] : `Tab ${index + 1}`;
}

const TS_NAMES = new Set(['typescript', 'ts', 'tsx', 'TypeScript']);

/**
 * Tabbed code blocks — replaces Mintlify's <CodeGroup>.
 * TypeScript tabs are always shown first.
 */
export function CodeGroup({ children }: CodeGroupProps) {
  const rawBlocks = Children.toArray(children).filter(
    (child): child is ReactElement => isValidElement(child) && child.type === 'pre'
  );

  const [active, setActive] = useState(0);

  if (rawBlocks.length <= 1) {
    return <>{rawBlocks}</>;
  }

  // Pair blocks with labels, then sort TypeScript first
  const pairs = rawBlocks.map((block, i) => ({ block, label: getLabel(block, i) }));
  pairs.sort((a, b) => {
    const aTs = TS_NAMES.has(a.label) ? 0 : 1;
    const bTs = TS_NAMES.has(b.label) ? 0 : 1;
    return aTs - bTs;
  });

  const labels = pairs.map((p) => p.label);
  const blocks = pairs.map((p) => p.block);

  return (
    <div className={styles.codeGroup}>
      <div className={styles.codeGroupTabs} role="tablist">
        {labels.map((label, i) => (
          <button
            key={label + i}
            role="tab"
            aria-selected={i === active}
            className={`${styles.codeGroupTab} ${i === active ? styles.codeGroupTabActive : ''}`}
            onClick={() => setActive(i)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className={styles.codeGroupPanel}>
        {blocks[active]}
      </div>
    </div>
  );
}
