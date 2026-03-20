import type { Metadata } from 'next';
import Link from 'next/link';

import styles from '../../components/blog/blog.module.css';
import { SiteFooter } from '../../components/SiteFooter';
import { SiteNav } from '../../components/SiteNav';
import { getAllPosts } from '../../lib/blog';

export const metadata: Metadata = {
  title: 'Blog',
  description: 'News, tutorials, and insights from the Agent Relay team.',
  alternates: {
    canonical: 'https://agentrelay.dev/blog',
  },
};

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function readTime(description: string): string {
  // Rough estimate based on description length
  const words = description.split(/\s+/).length;
  const mins = Math.max(3, Math.ceil(words / 40) + 2);
  return `${mins} min read`;
}

export default function BlogIndexPage() {
  const posts = getAllPosts();
  const featured = posts[0];
  const rest = posts.slice(1);

  return (
    <div className={styles.blogPage}>
      <SiteNav />

      <div className={styles.blogHero}>
        <h1 className={styles.blogTitle}>Blog</h1>
        <p className={styles.blogSubtitle}>
          Thoughts on multi-agent orchestration, building with AI, and the future of autonomous development.
        </p>
      </div>

      <div className={styles.blogLayout}>
        {/* Featured post */}
        {featured && (
          <Link href={`/blog/${encodeURIComponent(featured.slug)}`} className={styles.featuredCard}>
            <div className={styles.featuredAccent} />
            <div className={styles.featuredContent}>
              <div className={styles.postMeta}>
                <span className={styles.postCategory}>{featured.frontmatter.category}</span>
                <span className={styles.postDot}>·</span>
                <span>{formatDate(featured.frontmatter.date)}</span>
                <span className={styles.postDot}>·</span>
                <span>{readTime(featured.frontmatter.description)}</span>
              </div>
              <h2 className={styles.featuredTitle}>{featured.frontmatter.title}</h2>
              <p className={styles.featuredDesc}>{featured.frontmatter.description}</p>
              <div className={styles.featuredAuthor}>
                <div className={styles.authorAvatar}>{featured.frontmatter.author[0]}</div>
                <span className={styles.authorName}>{featured.frontmatter.author}</span>
              </div>
            </div>
          </Link>
        )}

        {/* Rest of posts */}
        {rest.length > 0 && (
          <div className={styles.postGrid}>
            {rest.map((post) => (
              <Link key={post.slug} href={`/blog/${encodeURIComponent(post.slug)}`} className={styles.postCard}>
                <div className={styles.postMeta}>
                  <span className={styles.postCategory}>{post.frontmatter.category}</span>
                  <span className={styles.postDot}>·</span>
                  <span>{formatDate(post.frontmatter.date)}</span>
                </div>
                <h3 className={styles.postCardTitle}>{post.frontmatter.title}</h3>
                <p className={styles.postCardDescription}>{post.frontmatter.description}</p>
                <div className={styles.postCardFooter}>
                  <span className={styles.postCardAuthor}>{post.frontmatter.author}</span>
                  <span className={styles.postCardRead}>{readTime(post.frontmatter.description)} &rarr;</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      <SiteFooter />
    </div>
  );
}
