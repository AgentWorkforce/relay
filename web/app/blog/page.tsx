import type { Metadata } from 'next';
import Link from 'next/link';

import styles from '../../components/blog/blog.module.css';
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
    month: 'long',
    day: 'numeric',
  });
}

export default function BlogIndexPage() {
  const posts = getAllPosts();
  const featured = posts[0];
  const rest = posts.slice(1);
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
      <SiteNav />

      <main className={styles.blogMain}>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
        />

        <section className={styles.blogHero}>
          <p className={styles.eyebrow}>Agent Relay Journal</p>
          <h1 className={styles.blogTitle}>Blog</h1>
          <p className={styles.blogSubtitle}>
            Thoughts on multi-agent orchestration, building with AI, and the future of autonomous development.
          </p>
        </section>

        {featured && (
          <section className={styles.blogSection}>
            <article>
              <Link href={`/blog/${encodeURIComponent(featured.slug)}`} className={styles.featuredCard}>
                <div className={styles.featuredContent}>
                  <div className={styles.postMeta}>
                    <span className={styles.postCategory}>{featured.frontmatter.category}</span>
                    <span className={styles.postDot}>·</span>
                    <time dateTime={featured.frontmatter.date}>{formatDate(featured.frontmatter.date)}</time>
                    <span className={styles.postDot}>·</span>
                    <span>{featured.readTime}</span>
                  </div>
                  <h3 className={styles.featuredTitle}>{featured.frontmatter.title}</h3>
                  <p className={styles.featuredDesc}>{featured.frontmatter.description}</p>
                  <div className={styles.featuredAuthor}>
                    <div className={styles.authorAvatar}>{featured.frontmatter.author[0]}</div>
                    <div className={styles.authorInfo}>
                      <span className={styles.authorLabel}>Written by</span>
                      <span className={styles.authorName}>{featured.frontmatter.author}</span>
                    </div>
                  </div>
                </div>
              </Link>
            </article>
          </section>
        )}

        {rest.length > 0 && (
          <section className={styles.blogSection} aria-labelledby="archive-heading">
            <h2 id="archive-heading" className={styles.listTitle}>
              More posts
            </h2>
            <div className={styles.postGrid}>
              {rest.map((post) => (
                <article key={post.slug}>
                  <Link href={`/blog/${encodeURIComponent(post.slug)}`} className={styles.postCard}>
                    <div className={styles.postMeta}>
                      <span className={styles.postCategory}>{post.frontmatter.category}</span>
                      <span className={styles.postDot}>·</span>
                      <time dateTime={post.frontmatter.date}>{formatDate(post.frontmatter.date)}</time>
                      <span className={styles.postDot}>·</span>
                      <span>{post.readTime}</span>
                    </div>
                    <h3 className={styles.postCardTitle}>{post.frontmatter.title}</h3>
                    <p className={styles.postCardDescription}>{post.frontmatter.description}</p>
                    <div className={styles.postCardFooter}>
                      <span className={styles.postCardAuthor}>{post.frontmatter.author}</span>
                      <span className={styles.postCardRead}>{post.readTime} &rarr;</span>
                    </div>
                  </Link>
                </article>
              ))}
            </div>
          </section>
        )}

        <div className={styles.blogBottom}>
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
      </main>

      <SiteFooter />
    </div>
  );
}
