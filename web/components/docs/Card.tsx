import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

import styles from './docs.module.css';

function isInternalHref(href: string): boolean {
  return href.startsWith('/') && !href.startsWith('//');
}

interface CardProps {
  title: string;
  icon?: string;
  href?: string;
  children?: ReactNode;
}

export function Card({ title, href, children }: CardProps) {
  const inner = (
    <>
      <div className={styles.cardHeader}>
        <h3 className={styles.cardTitle}>{title}</h3>
        {href && <ArrowRight className={styles.cardLinkIcon} aria-hidden="true" />}
      </div>
      {children && <div className={styles.cardBody}>{children}</div>}
    </>
  );

  if (href) {
    if (isInternalHref(href)) {
      return (
        <Link href={href} className={styles.card}>
          {inner}
        </Link>
      );
    }
    return (
      <a href={href} className={styles.card}>
        {inner}
      </a>
    );
  }

  return <div className={styles.card}>{inner}</div>;
}
