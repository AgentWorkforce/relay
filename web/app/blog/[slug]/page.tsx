import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { evaluate } from '@mdx-js/mdx';
import { Fragment, isValidElement, type HTMLAttributes, type ReactNode } from 'react';
import { jsx, jsxs } from 'react/jsx-runtime';
import remarkGfm from 'remark-gfm';

import { BlogTableOfContents } from '../../../components/blog/BlogTableOfContents';
import styles from '../../../components/blog/blog.module.css';
import { GitHubStarsBadge } from '../../../components/GitHubStars';
import { SiteFooter } from '../../../components/SiteFooter';
import { SiteNav } from '../../../components/SiteNav';
import { getAllPosts, getPost, getRelatedPosts, slugifyHeading } from '../../../lib/blog';
import { absoluteUrl, SITE_NAME, SITE_URL } from '../../../lib/site';

type PageProps = {
  params: Promise<{ slug: string }>;
};

function extractText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map((item) => extractText(item)).join('');
  }

  if (isValidElement<{ children?: ReactNode }>(node)) {
    return extractText(node.props.children);
  }

  return '';
}

function HeadingWithId(level: 2 | 3) {
  return function Heading({ children, ...props }: HTMLAttributes<HTMLHeadingElement>) {
    const id = slugifyHeading(extractText(children));
    const Tag = `h${level}` as const;

    return (
      <Tag id={id} {...props}>
        {children}
      </Tag>
    );
  };
}

const mdxComponents = {
  h2: HeadingWithId(2),
  h3: HeadingWithId(3),
};

export async function generateStaticParams() {
  return getAllPosts().map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) return { title: 'Not Found' };
  const postUrl = absoluteUrl(`/blog/${slug}`);
  const imageUrl = post.frontmatter.coverImage || absoluteUrl(`/blog/${slug}/opengraph-image`);

  return {
    title: post.frontmatter.title,
    description: post.frontmatter.description,
    keywords: [post.frontmatter.category, ...post.frontmatter.tags],
    authors: [{ name: post.frontmatter.author }],
    alternates: {
      canonical: postUrl,
    },
    openGraph: {
      title: post.frontmatter.title,
      description: post.frontmatter.description,
      url: postUrl,
      type: 'article',
      publishedTime: post.frontmatter.date,
      modifiedTime: post.frontmatter.updatedAt ?? post.frontmatter.date,
      authors: [post.frontmatter.author],
      section: post.frontmatter.category,
      tags: post.frontmatter.tags,
      images: [
        {
          url: imageUrl,
          alt: post.frontmatter.coverImageAlt || `${post.frontmatter.title} social card`,
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: post.frontmatter.title,
      description: post.frontmatter.description,
      images: [imageUrl],
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

  const otherPosts = getRelatedPosts(post, 4);
  const postUrl = absoluteUrl(`/blog/${slug}`);
  const imageUrl = post.frontmatter.coverImage || absoluteUrl(`/blog/${slug}/opengraph-image`);
  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.frontmatter.title,
    description: post.frontmatter.description,
    datePublished: post.frontmatter.date,
    dateModified: post.frontmatter.updatedAt ?? post.frontmatter.date,
    author: {
      '@type': 'Person',
      name: post.frontmatter.author,
    },
    publisher: {
      '@type': 'Organization',
      name: SITE_NAME,
      url: SITE_URL,
      logo: {
        '@type': 'ImageObject',
        url: absoluteUrl('/favicon.svg'),
      },
    },
    image: [imageUrl],
    mainEntityOfPage: postUrl,
    articleSection: post.frontmatter.category,
    keywords: post.frontmatter.tags.join(', '),
    about: post.frontmatter.tags.map((tag) => ({ '@type': 'Thing', name: tag })),
  };
  const breadcrumbData = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      {
        '@type': 'ListItem',
        position: 1,
        name: 'Blog',
        item: absoluteUrl('/blog'),
      },
      {
        '@type': 'ListItem',
        position: 2,
        name: post.frontmatter.title,
        item: postUrl,
      },
    ],
  };

  const { default: MDXContent } = await evaluate(post.content, {
    Fragment,
    jsx,
    jsxs,
    remarkPlugins: [remarkGfm],
  } as Parameters<typeof evaluate>[1]);

  return (
    <div className={styles.blogPage}>
      <SiteNav actions={<GitHubStarsBadge />} />

      <main className={styles.postShell}>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbData) }}
        />

        <div className={styles.postLayout}>
          <div className={styles.postMain}>
            <header className={styles.postHeader}>
              <div className={styles.postHeaderMeta}>
                <span className={styles.postHeaderCategory}>{post.frontmatter.category}</span>
                <span className={styles.postDot}>·</span>
                <time dateTime={post.frontmatter.date}>{formatDate(post.frontmatter.date)}</time>
                <span className={styles.postDot}>·</span>
                <span>{post.readTime}</span>
                <span className={styles.postDot}>·</span>
                <span>{post.frontmatter.author}</span>
              </div>
              <h1 className={styles.postHeaderTitle}>{post.frontmatter.title}</h1>
              <p className={styles.postDek}>{post.frontmatter.description}</p>
            </header>

            {post.toc.length > 0 && (
              <div className={styles.mobileToc}>
                <div className={styles.sidebarCard}>
                  <h2 className={styles.sidebarTitle}>On this page</h2>
                  <BlogTableOfContents items={post.toc} />
                </div>
              </div>
            )}

            <article className={styles.article}>
              <MDXContent components={mdxComponents} />
            </article>

            {otherPosts.length > 0 && (
              <section className={styles.articleFooter} aria-labelledby="continue-reading-heading">
                <h2 id="continue-reading-heading" className={styles.listTitle}>
                  More posts
                </h2>
                <div className={styles.postGrid}>
                  {otherPosts.map((relatedPost) => (
                    <article key={relatedPost.slug}>
                      <Link href={`/blog/${relatedPost.slug}`} className={styles.postCard}>
                        <div className={styles.postMeta}>
                          <span className={styles.postCategory}>{relatedPost.frontmatter.category}</span>
                          <span className={styles.postDot}>·</span>
                          <time dateTime={relatedPost.frontmatter.date}>
                            {formatDate(relatedPost.frontmatter.date)}
                          </time>
                        </div>
                        <h3 className={styles.postCardTitle}>{relatedPost.frontmatter.title}</h3>
                        <p className={styles.postCardDescription}>{relatedPost.frontmatter.description}</p>
                        <div className={styles.postCardFooter}>
                          <span className={styles.postCardAuthor}>{relatedPost.frontmatter.author}</span>
                          <span className={styles.postCardRead}>{relatedPost.readTime} &rarr;</span>
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
          </div>

          <aside className={styles.postSidebar}>
            <div className={styles.sidebarSticky}>
              {post.toc.length > 0 && (
                <div className={styles.sidebarCard}>
                  <h2 className={styles.sidebarTitle}>On this page</h2>
                  <BlogTableOfContents items={post.toc} />
                </div>
              )}

              {otherPosts.length > 0 && (
                <div className={styles.sidebarCard}>
                  <h2 className={styles.sidebarTitle}>More posts</h2>
                  <div className={styles.sidebarPosts}>
                    {otherPosts.slice(0, 3).map((p) => (
                      <Link key={p.slug} href={`/blog/${p.slug}`} className={styles.sidebarPost}>
                        <span className={styles.sidebarPostCategory}>{p.frontmatter.category}</span>
                        <span className={styles.sidebarPostTitle}>{p.frontmatter.title}</span>
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </aside>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
