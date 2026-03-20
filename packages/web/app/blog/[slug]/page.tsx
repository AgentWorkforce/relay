import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { evaluate } from '@mdx-js/mdx';
import { Fragment } from 'react';
import { jsx, jsxs } from 'react/jsx-runtime';
import remarkGfm from 'remark-gfm';

import styles from '../../../components/blog/blog.module.css';
import { SiteNav } from '../../../components/SiteNav';
import { getAllPosts, getPost } from '../../../lib/blog';

type PageProps = {
  params: Promise<{ slug: string }>;
};

export async function generateStaticParams() {
  return getAllPosts().map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) return { title: 'Not Found' };

  return {
    title: post.frontmatter.title,
    description: post.frontmatter.description,
    alternates: {
      canonical: `https://agentrelay.dev/blog/${slug}`,
    },
    openGraph: {
      title: post.frontmatter.title,
      description: post.frontmatter.description,
      url: `https://agentrelay.dev/blog/${slug}`,
      type: 'article',
      publishedTime: post.frontmatter.date,
      authors: [post.frontmatter.author],
    },
  };
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export default async function BlogPostPage({ params }: PageProps) {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) notFound();

  const { default: MDXContent } = await evaluate(post.content, {
    Fragment,
    jsx,
    jsxs,
    remarkPlugins: [remarkGfm],
  } as Parameters<typeof evaluate>[1]);

  return (
    <div className={styles.blogPage}>
      <SiteNav />
      <div className={styles.blogLayout}>
        <header className={styles.postHeader}>
          <a href="/blog" className={styles.backLink}>
            &larr; Back to blog
          </a>
          <h1 className={styles.postHeaderTitle}>{post.frontmatter.title}</h1>
          <div className={styles.postHeaderMeta}>
            <span className={styles.postHeaderCategory}>{post.frontmatter.category}</span>
            <span>{formatDate(post.frontmatter.date)}</span>
            <span>{post.frontmatter.author}</span>
          </div>
        </header>

        <article className={styles.article}>
          <MDXContent />
        </article>
      </div>
    </div>
  );
}
