import type { Metadata } from 'next';
import Link from 'next/link';

import styles from '../../components/blog/blog.module.css';
import { GitHubStarsBadge } from '../../components/GitHubStars';
import { SiteFooter } from '../../components/SiteFooter';
import { SiteNav } from '../../components/SiteNav';
import { getAllPosts } from '../../lib/blog';
import { absoluteUrl, SITE_NAME, SITE_URL } from '../../lib/site';

export const metadata: Metadata = {
  title: 'Blog',
  description: 'News, tutorials, and insights from the Agent Relay team.',
  alternates: {
    canonical: absoluteUrl('/blog'),
  },
  openGraph: {
    title: `${SITE_NAME} Blog`,
    description: 'Essays, playbooks, and product thinking on multi-agent systems and AI coordination.',
    url: absoluteUrl('/blog'),
    type: 'website',
    images: [absoluteUrl('/opengraph-image')],
  },
  twitter: {
    card: 'summary_large_image',
    title: `${SITE_NAME} Blog`,
    description: 'Essays, playbooks, and product thinking on multi-agent systems and AI coordination.',
    images: [absoluteUrl('/opengraph-image')],
  },
};

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export default function BlogIndexPage() {
  const posts = getAllPosts();
  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: `${SITE_NAME} Blog`,
    url: absoluteUrl('/blog'),
    description: 'Essays, playbooks, and product thinking on multi-agent systems and AI coordination.',
    isPartOf: SITE_URL,
    mainEntity: {
      '@type': 'ItemList',
      itemListElement: posts.map((post, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: post.frontmatter.title,
        url: absoluteUrl(`/blog/${post.slug}`),
      })),
    },
  };

  return (
    <div className={styles.blogPage}>
      <SiteNav actions={<GitHubStarsBadge />} />

      <main className={styles.blogMain}>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
        />

        <section className={styles.blogHero}>
          <div className={styles.blogHeader}>
            <h1 className={styles.blogTitle}>Blog</h1>
            <a href="/feed.xml" className={styles.rssIconLink} aria-label="RSS feed">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M6 17.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM4.5 10.5a9 9 0 0 1 9 9"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
                <path
                  d="M4.5 4.5c8.284 0 15 6.716 15 15"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
            </a>
          </div>
          <p className={styles.blogSubtitle}>
            Thoughts on multi-agent orchestration, building with AI, and the future of autonomous development.
          </p>
        </section>

        {posts.length > 0 && (
          <section className={styles.blogSection}>
            <div className={styles.postList} role="list">
              {posts.map((post) => (
                <article key={post.slug} className={styles.postListRow} role="listitem">
                  <Link href={`/blog/${encodeURIComponent(post.slug)}`} className={styles.postListLink}>
                    {post.frontmatter.title}
                  </Link>
                  <div className={styles.postListMeta}>
                    <span className={styles.postListAuthor}>{post.frontmatter.author}</span>
                    <span className={styles.postListDot} aria-hidden="true">
                      &middot;
                    </span>
                    <time className={styles.postListDate} dateTime={post.frontmatter.date}>
                      {formatDate(post.frontmatter.date)}
                    </time>
                    <span className={styles.postListDot} aria-hidden="true">
                      &middot;
                    </span>
                    <span className={styles.postListRead}>{post.readTime}</span>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}
      </main>

      <SiteFooter />
    </div>
  );
}
