'use client';

import { useEffect, useState, type ReactNode, type ReactElement, Children, isValidElement } from 'react';

import { normalizeDocsLanguageLabel, useDocsLanguage } from './DocsLanguageContext';
import styles from './docs.module.css';

interface CodeGroupProps {
  children: ReactNode;
}

function findCodeElement(node: ReactNode): ReactElement | null {
  if (!isValidElement(node)) {
    return null;
  }

  if (node.type === 'code') {
    return node;
  }

  for (const child of Children.toArray(node.props.children)) {
    const found = findCodeElement(child);
    if (found) {
      return found;
    }
  }

  return null;
}

function getLabel(block: ReactElement, index: number): string {
  if (block.props['data-label']) {
    return block.props['data-label'] as string;
  }
  const code = findCodeElement(block);
  if (!code) return `Tab ${index + 1}`;
  const className = code.props.className || '';
  const match = className.match(/language-(\S+)/);
  return match ? match[1] : `Tab ${index + 1}`;
}

export function CodeGroup({ children }: CodeGroupProps) {
  const { language, setLanguage } = useDocsLanguage();
  const rawBlocks = Children.toArray(children).filter(
    (child): child is ReactElement => isValidElement(child)
  );

  if (rawBlocks.length <= 1) {
    return <>{children}</>;
  }

  const pairs = rawBlocks.map((block, i) => ({ block, label: getLabel(block, i) }));
  const labels = pairs.map((p) => p.label);
  const blocks = pairs.map((p) => p.block);
  const preferredIndex = labels.findIndex((label) => normalizeDocsLanguageLabel(label) === language);
  const isLanguageOnlyGroup = labels.every((label) => normalizeDocsLanguageLabel(label) !== null);
  const [active, setActive] = useState(preferredIndex === -1 ? 0 : preferredIndex);

  useEffect(() => {
    if (preferredIndex !== -1) {
      setActive(preferredIndex);
    }
  }, [preferredIndex]);

  return (
    <div className={styles.codeGroup}>
      <div
        className={`${styles.codeGroupTabs} ${isLanguageOnlyGroup ? styles.codeGroupTabsHidden : ''}`}
        role="tablist"
        aria-hidden={isLanguageOnlyGroup}
      >
        {labels.map((label, i) => (
          <button
            key={label + i}
            role="tab"
            aria-selected={i === active}
            className={`${styles.codeGroupTab} ${i === active ? styles.codeGroupTabActive : ''}`}
            onClick={() => {
              const nextLanguage = normalizeDocsLanguageLabel(label);
              if (nextLanguage) {
                setLanguage(nextLanguage);
              }
              setActive(i);
            }}
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
