import type { Metadata } from 'next';
import type React from 'react';
import { notFound } from 'next/navigation';
import { evaluate } from '@mdx-js/mdx';
import { Fragment } from 'react';
import { jsx, jsxs } from 'react/jsx-runtime';
import remarkGfm from 'remark-gfm';

import { BannerLink } from '../../../../components/docs/BannerLink';
import { Card } from '../../../../components/docs/Card';
import { CardGroup } from '../../../../components/docs/CardGroup';
import { CodeGroup } from '../../../../components/docs/CodeGroup';
import { HighlightedPre } from '../../../../components/docs/HighlightedCode';
import { LegacySpawnOptionsTable } from '../../../../components/docs/LegacySpawnOptionsTable';
import { Note } from '../../../../components/docs/Note';
import { TableOfContents } from '../../../../components/docs/TableOfContents';
import { Warning } from '../../../../components/docs/Warning';
import styles from '../../../../components/docs/docs.module.css';
import { getDoc } from '../../../../lib/docs';
import { getAllLegacyDocSlugs } from '../../../../lib/docs-nav';
import { defaultOgImage } from '../../../../lib/og-meta';
import { absoluteUrl } from '../../../../lib/site';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function HeadingWithId(level: 2 | 3) {
  return function Heading({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
    const text = typeof children === 'string' ? children : String(children);
    const id = slugify(text);
    const Tag = `h${level}` as const;
    return (
      <Tag id={id} {...props}>
        {children}
      </Tag>
    );
  };
}

const components = {
  BannerLink,
  Card,
  CardGroup,
  CodeGroup,
  Note,
  Warning,
  SpawnOptionsTable: LegacySpawnOptionsTable,
  pre: HighlightedPre,
  h2: HeadingWithId(2),
  h3: HeadingWithId(3),
};

type PageProps = {
  params: Promise<{ slug: string }>;
};

export async function generateStaticParams() {
  return getAllLegacyDocSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const doc = getDoc(slug, 'v7.1.1');

  if (!doc) {
    return { title: 'Not Found' };
  }

  return {
    title: `${doc.frontmatter.title} - Version 7.1.1`,
    description: doc.frontmatter.description,
    alternates: {
      canonical: absoluteUrl(`/docs/7.1.1/${slug}`),
    },
    openGraph: {
      title: `${doc.frontmatter.title} - Version 7.1.1`,
      description: doc.frontmatter.description,
      url: absoluteUrl(`/docs/7.1.1/${slug}`),
      type: 'article',
      images: [defaultOgImage()],
    },
    twitter: {
      card: 'summary_large_image',
      title: `${doc.frontmatter.title} - Version 7.1.1`,
      description: doc.frontmatter.description,
      images: [defaultOgImage().url],
    },
  };
}

export default async function LegacyDocsPage({ params }: PageProps) {
  const { slug } = await params;
  const doc = getDoc(slug, 'v7.1.1');

  if (!doc) {
    notFound();
  }

  const { default: MDXContent } = await evaluate(doc.content, {
    Fragment,
    jsx,
    jsxs,
    remarkPlugins: [remarkGfm],
  } as Parameters<typeof evaluate>[1]);

  return (
    <div className={styles.articleWrapper}>
      <article className={styles.article}>
        <div className={styles.articleHeader}>
          <div className={styles.articleHeading}>
            <h1>{doc.frontmatter.title}</h1>
          </div>
        </div>
        {doc.frontmatter.description && (
          <p className={styles.articleDescription}>{doc.frontmatter.description}</p>
        )}
        <div className={styles.articleBody}>
          <MDXContent components={components} />
        </div>
      </article>
      <aside className={styles.tocSidebar}>
        <TableOfContents items={doc.toc} />
      </aside>
    </div>
  );
}
