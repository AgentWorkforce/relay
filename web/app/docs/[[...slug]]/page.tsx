import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { evaluate } from '@mdx-js/mdx';
import { Fragment } from 'react';
import { jsx, jsxs } from 'react/jsx-runtime';

import { Card } from '../../../components/docs/Card';
import { CardGroup } from '../../../components/docs/CardGroup';
import { CodeGroup } from '../../../components/docs/CodeGroup';
import { Note } from '../../../components/docs/Note';
import styles from '../../../components/docs/docs.module.css';
import { getDoc } from '../../../lib/docs';
import { getAllDocSlugs } from '../../../lib/docs-nav';

const components = {
  CodeGroup,
  Card,
  CardGroup,
  Note,
};

type PageProps = {
  params: Promise<{
    slug?: string[];
  }>;
};

function slugToPath(slug?: string[]): string {
  if (!slug || slug.length === 0) return 'introduction';
  return slug.join('/');
}

export async function generateStaticParams() {
  const slugs = getAllDocSlugs();
  return [
    { slug: undefined },
    ...slugs.map((s) => ({ slug: s.split('/') })),
  ];
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const docSlug = slugToPath(slug);
  const doc = getDoc(docSlug);

  if (!doc) {
    return { title: 'Not Found' };
  }

  const urlPath = slug ? `/docs/${slug.join('/')}` : '/docs';

  return {
    title: doc.frontmatter.title,
    description: doc.frontmatter.description,
    alternates: {
      canonical: `https://agentrelay.dev${urlPath}`,
    },
    openGraph: {
      title: doc.frontmatter.title,
      description: doc.frontmatter.description,
      url: `https://agentrelay.dev${urlPath}`,
      type: 'article',
    },
  };
}

export default async function DocsPage({ params }: PageProps) {
  const { slug } = await params;
  const docSlug = slugToPath(slug);
  const doc = getDoc(docSlug);

  if (!doc) {
    notFound();
  }

  const { default: MDXContent } = await evaluate(doc.content, {
    Fragment,
    jsx,
    jsxs,
  } as Parameters<typeof evaluate>[1]);

  return (
    <article className={styles.article}>
      <h1>{doc.frontmatter.title}</h1>
      {doc.frontmatter.description && (
        <p className={styles.articleDescription}>{doc.frontmatter.description}</p>
      )}
      <MDXContent components={components} />
    </article>
  );
}
