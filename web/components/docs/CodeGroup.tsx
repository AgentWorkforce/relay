'use client';

import { useState, type ReactNode, type ReactElement, Children, isValidElement } from 'react';

import styles from './docs.module.css';

interface CodeGroupProps {
  children: ReactNode;
}

/**
 * Tabbed code blocks — replaces Mintlify's <CodeGroup>.
 * Expects children to be <pre> elements wrapping <code> elements.
 * Tab labels are extracted from the data-language or className.
 */
export function CodeGroup({ children }: CodeGroupProps) {
  const blocks = Children.toArray(children).filter(
    (child): child is ReactElement => isValidElement(child) && child.type === 'pre'
  );

  const [active, setActive] = useState(0);

  if (blocks.length === 0) {
    return <>{children}</>;
  }

  if (blocks.length === 1) {
    return <>{children}</>;
  }

  const labels = blocks.map((block, i) => {
    // First check for data-label on <pre> (set by our preprocessor for labeled code blocks)
    if (block.props['data-label']) {
      return block.props['data-label'] as string;
    }

    // Fall back to extracting language from <code> className
    const code = Children.toArray(block.props.children).find(
      (c): c is ReactElement => isValidElement(c) && c.type === 'code'
    );
    if (!code) return `Tab ${i + 1}`;

    const className = code.props.className || '';
    const match = className.match(/language-(\S+)/);
    return match ? match[1] : `Tab ${i + 1}`;
  });

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
      <div className={styles.codeGroupPanel}>{blocks[active]}</div>
    </div>
  );
}
