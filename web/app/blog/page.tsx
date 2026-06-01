import type { Metadata } from 'next';
import Link from 'next/link';
import { Rss } from 'lucide-react';

import styles from '../../components/blog/blog.module.css';
import { GitHubStarsBadge } from '../../components/GitHubStars';
import { SiteFooter } from '../../components/SiteFooter';
import { SiteNav } from '../../components/SiteNav';
import { getAllPosts } from '../../lib/blog';
import { getAuthorInitials, getBlogAuthor } from '../../lib/blog-authors';
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
  const [year, month, day] = dateStr.split('-').map(Number);

  return new Date(year, month - 1, day).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export default function BlogIndexPage() {
  const posts = getAllPosts();
  const allPosts = posts;
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
          <div className={styles.blogHeroInner}>
            <div className={styles.blogHeader}>
              <a href="/feed.xml" className={styles.rssIconLink} aria-label="RSS feed">
                <Rss aria-hidden="true" />
              </a>
            </div>
            <h1 className={styles.blogTitle}>Human thoughts on agentic software</h1>
            <p className={styles.blogSubtitle}>
              Essays, playbooks, and product thinking on multi-agent systems, context rails, and autonomous
              development.
            </p>
          </div>
        </section>
        <div className={styles.blogWaveDivider} aria-hidden="true">
          <svg viewBox="0 0 1200 80" fill="none" preserveAspectRatio="none">
            <path d="M0 0H1200V18C986 58 826 24 624 46C404 70 228 34 0 60V0Z" />
            <path d="M-80 34C170 58 372 54 612 40C858 26 1018 20 1280 42" />
            <path d="M-80 48C184 70 384 66 632 52C878 38 1036 34 1280 56" />
          </svg>
        </div>

        {allPosts.length > 0 && (
          <section
            className={`${styles.blogSection} ${styles.archiveSection}`}
            aria-labelledby="all-posts-heading"
          >
            <div className={styles.sectionHeader}>
              <div>
                <h2 id="all-posts-heading" className={styles.sectionTitle}>
                  All posts
                </h2>
              </div>
            </div>

            <div className={styles.postList} role="list">
              {allPosts.map((post) => {
                const postAuthor = getBlogAuthor(post.frontmatter.author);

                return (
                  <article key={post.slug} className={styles.postListRow} role="listitem">
                    <Link href={`/blog/${encodeURIComponent(post.slug)}`} className={styles.postListRowLink}>
                      <div className={styles.postListTopline}>
                        <h3 className={styles.postListTitle}>{post.frontmatter.title}</h3>
                        <span className={styles.postListMeta}>
                          <span
                            className={`${styles.postListAvatar} ${postAuthor.image ? styles.authorAvatarPhoto : ''}`}
                            aria-hidden="true"
                          >
                            {postAuthor.image ? (
                              <img src={postAuthor.image} alt="" loading="lazy" />
                            ) : (
                              getAuthorInitials(postAuthor.name)
                            )}
                          </span>
                          <span className={styles.postListMetaText}>
                            <span className={styles.postListAuthor}>{postAuthor.name}</span>
                            <span className={styles.postListTime}>
                              <time className={styles.postListDate} dateTime={post.frontmatter.date}>
                                {formatDate(post.frontmatter.date)}
                              </time>
                              <span className={styles.postListDot} aria-hidden="true">
                                &middot;
                              </span>
                              <span className={styles.postListRead}>{post.readTime}</span>
                            </span>
                          </span>
                        </span>
                      </div>
                      <p className={styles.postListDescription}>{post.frontmatter.description}</p>
                    </Link>
                  </article>
                );
              })}
            </div>
          </section>
        )}
      </main>

      <SiteFooter />
    </div>
  );
}
