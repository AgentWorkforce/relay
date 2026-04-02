import type { Metadata } from 'next';
import type React from 'react';
import { notFound } from 'next/navigation';
import { evaluate } from '@mdx-js/mdx';
import { Fragment } from 'react';
import { jsx, jsxs } from 'react/jsx-runtime';
import remarkGfm from 'remark-gfm';

import { Card } from '../../../components/docs/Card';
import { CardGroup } from '../../../components/docs/CardGroup';
import { BannerLink } from '../../../components/docs/BannerLink';
import { CodeGroup } from '../../../components/docs/CodeGroup';
import { DocsPageActions } from '../../../components/docs/DocsPageActions';
import { HighlightedPre } from '../../../components/docs/HighlightedCode';
import { Note } from '../../../components/docs/Note';
import { TableOfContents } from '../../../components/docs/TableOfContents';
import styles from '../../../components/docs/docs.module.css';
import { getDoc } from '../../../lib/docs';
import { getDocMarkdownUrl } from '../../../lib/docs-markdown';
import { getAllDocSlugs } from '../../../lib/docs-nav';

function slugify(text: string): string {
  return text.toLowerCase().replace(/`([^`]+)`/g, '$1').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function HeadingWithId(level: 2 | 3) {
  return function Heading({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
    const text = typeof children === 'string' ? children : String(children);
    const id = slugify(text);
    const Tag = `h${level}` as const;
    return <Tag id={id} {...props}>{children}</Tag>;
  };
}

const components = {
  CodeGroup,
  Card,
  CardGroup,
  BannerLink,
  Note,
  pre: HighlightedPre,
  h2: HeadingWithId(2),
  h3: HeadingWithId(3),
};

type PageProps = {
  params: Promise<{ slug: string }>;
};

export async function generateStaticParams() {
  return getAllDocSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const doc = getDoc(slug);

  if (!doc) {
    return { title: 'Not Found' };
  }

  return {
    title: doc.frontmatter.title,
    description: doc.frontmatter.description,
    alternates: {
      canonical: `https://agentrelay.dev/docs/${slug}`,
    },
    openGraph: {
      title: doc.frontmatter.title,
      description: doc.frontmatter.description,
      url: `https://agentrelay.dev/docs/${slug}`,
      type: 'article',
    },
  };
}

export default async function DocsPage({ params }: PageProps) {
  const { slug } = await params;
  const doc = getDoc(slug);

  if (!doc) {
    notFound();
  }

  const { default: MDXContent } = await evaluate(doc.content, {
    Fragment,
    jsx,
    jsxs,
    remarkPlugins: [remarkGfm],
  } as Parameters<typeof evaluate>[1]);

  const pageUrl = `https://agentrelay.dev/docs/${slug}`;
  const markdownPath = `/docs/markdown/${slug}.md`;
  const markdownUrl = getDocMarkdownUrl(slug);

  return (
    <div className={styles.articleWrapper}>
      <article className={styles.article}>
        <div className={styles.articleHeader}>
          <div className={styles.articleHeading}>
            <h1>{doc.frontmatter.title}</h1>
          </div>
          <DocsPageActions
            title={doc.frontmatter.title}
            pageUrl={pageUrl}
            markdownPath={markdownPath}
            markdownUrl={markdownUrl}
          />
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
