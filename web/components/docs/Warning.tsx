import type { ReactNode } from 'react';

import styles from './docs.module.css';

interface WarningProps {
  children: ReactNode;
}

export function Warning({ children }: WarningProps) {
  return <div className={styles.warning}>{children}</div>;
}
