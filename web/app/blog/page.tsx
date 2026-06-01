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
  const [featuredPost, ...recentPosts] = posts;
  const featuredAuthor = featuredPost ? getBlogAuthor(featuredPost.frontmatter.author) : null;
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
            <h1 className={styles.blogTitle}>Field notes for agent-native software</h1>
            <p className={styles.blogSubtitle}>
              Essays, playbooks, and product thinking on multi-agent systems, context rails, and autonomous
              development.
            </p>
          </div>
        </section>

        {featuredPost && (
          <section className={styles.blogSection} aria-labelledby="featured-post-heading">
            <div className={styles.sectionHeader}>
              <div>
                <p className={styles.sectionKicker}>Latest</p>
                <h2 id="featured-post-heading" className={styles.sectionTitle}>
                  Start here
                </h2>
              </div>
              <p className={styles.sectionDescription}>
                The newest thinking from the team building communication infrastructure for agents.
              </p>
            </div>

            <Link href={`/blog/${encodeURIComponent(featuredPost.slug)}`} className={styles.featuredCard}>
              <div className={styles.featuredContent}>
                <div className={styles.postMeta}>
                  <span className={styles.postCategory}>{featuredPost.frontmatter.category}</span>
                  <span className={styles.postDot}>·</span>
                  <time dateTime={featuredPost.frontmatter.date}>{formatDate(featuredPost.frontmatter.date)}</time>
                  <span className={styles.postDot}>·</span>
                  <span>{featuredPost.readTime}</span>
                </div>
                <h3 className={styles.featuredTitle}>{featuredPost.frontmatter.title}</h3>
                <p className={styles.featuredDesc}>{featuredPost.frontmatter.description}</p>
                <div className={styles.featuredAuthor}>
                  <span
                    className={`${styles.authorAvatar} ${featuredAuthor?.image ? styles.authorAvatarPhoto : ''}`}
                    aria-hidden="true"
                  >
                    {featuredAuthor?.image ? (
                      <img src={featuredAuthor.image} alt="" loading="lazy" />
                    ) : (
                      getAuthorInitials(featuredAuthor?.name ?? featuredPost.frontmatter.author)
                    )}
                  </span>
                  <span className={styles.authorInfo}>
                    <span className={styles.authorLabel}>Written by</span>
                    <span className={styles.authorName}>{featuredAuthor?.name ?? featuredPost.frontmatter.author}</span>
                    {featuredAuthor && <span className={styles.authorRole}>{featuredAuthor.title}</span>}
                  </span>
                </div>
              </div>
            </Link>
          </section>
        )}

        {recentPosts.length > 0 && (
          <section className={styles.blogSection} aria-labelledby="recent-posts-heading">
            <div className={styles.sectionHeader}>
              <div>
                <p className={styles.sectionKicker}>Archive</p>
                <h2 id="recent-posts-heading" className={styles.sectionTitle}>
                  Recent writing
                </h2>
              </div>
            </div>

            <div className={styles.postList} role="list">
              {recentPosts.map((post) => (
                <article key={post.slug} className={styles.postListRow} role="listitem">
                  <Link href={`/blog/${encodeURIComponent(post.slug)}`} className={styles.postListLink}>
                    {post.frontmatter.title}
                  </Link>
                  <p className={styles.postListDescription}>{post.frontmatter.description}</p>
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
