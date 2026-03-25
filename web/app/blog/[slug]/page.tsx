import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { evaluate } from '@mdx-js/mdx';
import { Fragment } from 'react';
import { jsx, jsxs } from 'react/jsx-runtime';
import remarkGfm from 'remark-gfm';

import styles from '../../../components/blog/blog.module.css';
import { SiteFooter } from '../../../components/SiteFooter';
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

  const allPosts = getAllPosts();
  const otherPosts = allPosts.filter((p) => p.slug !== slug).slice(0, 4);

  const { default: MDXContent } = await evaluate(post.content, {
    Fragment,
    jsx,
    jsxs,
    remarkPlugins: [remarkGfm],
  } as Parameters<typeof evaluate>[1]);

  return (
    <div className={styles.blogPage}>
      <SiteNav />

      <div className={styles.postLayout}>
        <div className={styles.postMain}>
          <header className={styles.postHeader}>
            <Link href="/blog" className={styles.backLink}>
              &larr; All posts
            </Link>
            <div className={styles.postHeaderMeta}>
              <span className={styles.postHeaderCategory}>{post.frontmatter.category}</span>
              <span className={styles.postDot}>·</span>
              <span>{formatDate(post.frontmatter.date)}</span>
              <span className={styles.postDot}>·</span>
              <span>{post.readTime}</span>
              <span className={styles.postDot}>·</span>
              <span>{post.frontmatter.author}</span>
            </div>
            <h1 className={styles.postHeaderTitle}>{post.frontmatter.title}</h1>
          </header>

          <article className={styles.article}>
            <MDXContent />
          </article>
        </div>

        <aside className={styles.postSidebar}>
          <div className={styles.sidebarSticky}>
            <div className={styles.sidebarSection}>
              <h4 className={styles.sidebarTitle}>More posts</h4>
              <div className={styles.sidebarPosts}>
                {otherPosts.map((p) => (
                  <Link key={p.slug} href={`/blog/${p.slug}`} className={styles.sidebarPost}>
                    <span className={styles.sidebarPostCategory}>{p.frontmatter.category}</span>
                    <span className={styles.sidebarPostTitle}>{p.frontmatter.title}</span>
                  </Link>
                ))}
              </div>
            </div>

            <div className={styles.sidebarSection}>
              <h4 className={styles.sidebarTitle}>Resources</h4>
              <div className={styles.sidebarLinks}>
                <Link href="/docs" className={styles.sidebarLink}>Documentation</Link>
                <Link href="/docs/quickstart" className={styles.sidebarLink}>Quickstart</Link>
                <a href="https://github.com/agentworkforce/relay" target="_blank" rel="noopener noreferrer" className={styles.sidebarLink}>GitHub</a>
              </div>
            </div>
          </div>
        </aside>
      </div>

      <SiteFooter />
    </div>
  );
}
