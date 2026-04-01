import type { ReactNode } from 'react';

import styles from './docs.module.css';

interface CardProps {
  title: string;
  icon?: string;
  href?: string;
  children?: ReactNode;
}

export function Card({ title, href, children }: CardProps) {
  const inner = (
    <>
      <h3 className={styles.cardTitle}>{title}</h3>
      {children && <div className={styles.cardBody}>{children}</div>}
    </>
  );

  if (href) {
    return (
      <a href={href} className={styles.card}>
        {inner}
      </a>
    );
  }

  return <div className={styles.card}>{inner}</div>;
}
