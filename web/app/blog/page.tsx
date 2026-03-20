import type { Metadata } from 'next';

import styles from '../../components/blog/blog.module.css';
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

export default function BlogIndexPage() {
  const posts = getAllPosts();

  return (
    <div className={styles.blogPage}>
      <SiteNav />
      <div className={styles.blogLayout}>
        <header className={styles.blogHeader}>
          <h1 className={styles.blogTitle}>Blog</h1>
          <p className={styles.blogSubtitle}>News, tutorials, and insights from the Agent Relay team.</p>
        </header>

        <div className={styles.postList}>
          {posts.map((post) => (
            <a key={post.slug} href={`/blog/${post.slug}`} className={styles.postCard}>
              <div className={styles.postMeta}>
                <span className={styles.postCategory}>{post.frontmatter.category}</span>
                <span>{formatDate(post.frontmatter.date)}</span>
                <span>{post.frontmatter.author}</span>
              </div>
              <h2 className={styles.postCardTitle}>{post.frontmatter.title}</h2>
              <p className={styles.postCardDescription}>{post.frontmatter.description}</p>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
