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
      {children && <p className={styles.cardBody}>{children}</p>}
    </>
  );

  if (href) {
    const resolvedHref = href.startsWith('/') ? `/docs${href}` : href;
    return (
      <a href={resolvedHref} className={styles.card}>
        {inner}
      </a>
    );
  }

  return <div className={styles.card}>{inner}</div>;
}
