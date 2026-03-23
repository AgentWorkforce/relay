import type { ReactNode } from 'react';

import styles from './docs.module.css';

interface CardGroupProps {
  cols?: number;
  children: ReactNode;
}

export function CardGroup({ cols = 2, children }: CardGroupProps) {
  return (
    <div
      className={styles.cardGroup}
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {children}
    </div>
  );
}
