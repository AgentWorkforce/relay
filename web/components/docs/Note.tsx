import type { ReactNode } from 'react';

import styles from './docs.module.css';

interface NoteProps {
  children: ReactNode;
}

export function Note({ children }: NoteProps) {
  return <div className={styles.note}>{children}</div>;
}
