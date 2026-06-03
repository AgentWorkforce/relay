import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { evaluate } from '@mdx-js/mdx';
import { CalendarDays, Clock3, Rss } from 'lucide-react';
import { Fragment, isValidElement, type HTMLAttributes, type ReactNode } from 'react';
import { FaGithub, FaLinkedinIn, FaXTwitter } from 'react-icons/fa6';
import { jsx, jsxs } from 'react/jsx-runtime';
import remarkGfm from 'remark-gfm';

import { BlogTableOfContents } from '../../../components/blog/BlogTableOfContents';
import styles from '../../../components/blog/blog.module.css';
import { HighlightedPre } from '../../../components/docs/HighlightedCode';
import { GitHubStarsBadge } from '../../../components/GitHubStars';
import { Waitlist } from '../../../components/home';
import { SiteFooter } from '../../../components/SiteFooter';
import { SiteNav } from '../../../components/SiteNav';
import { getAllPosts, getPost, slugifyHeading } from '../../../lib/blog';
import { getAuthorInitials, getBlogAuthor } from '../../../lib/blog-authors';
import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH } from '../../../lib/og-meta';
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
  pre: HighlightedPre,
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
  const usingGeneratedCard = !post.frontmatter.coverImage;
  const imageUrl = post.frontmatter.coverImage || absoluteUrl(`/blog/${slug}/og.png`);

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
          ...(usingGeneratedCard
            ? { width: OG_IMAGE_WIDTH, height: OG_IMAGE_HEIGHT, type: 'image/png' as const }
            : {}),
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
  const [year, month, day] = dateStr.split('-').map(Number);

  return new Date(year, month - 1, day).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function formatFooterReadTime(readTime: string): string {
  return readTime.replace('min read', 'minute read');
}

export default async function BlogPostPage({ params }: PageProps) {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) notFound();

  const author = getBlogAuthor(post.frontmatter.author);
  const otherPosts = getAllPosts()
    .filter((candidate) => candidate.slug !== post.slug)
    .slice(0, 4);
  const postUrl = absoluteUrl(`/blog/${slug}`);
  const imageUrl = post.frontmatter.coverImage || absoluteUrl(`/blog/${slug}/og.png`);
  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.frontmatter.title,
    description: post.frontmatter.description,
    datePublished: post.frontmatter.date,
    dateModified: post.frontmatter.updatedAt ?? post.frontmatter.date,
    author: {
      '@type': 'Person',
      name: author.name,
      jobTitle: author.title,
      ...(author.image ? { image: absoluteUrl(author.image) } : {}),
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
  const authorInitials = getAuthorInitials(author.name);
  const renderAuthorPanel = (headingId: string) => (
    <section className={styles.authorPanel} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.sidebarTitle}>
        Written by
      </h2>
      <div className={styles.authorCard}>
        <span
          className={`${styles.authorAvatar} ${author.image ? styles.authorAvatarPhoto : ''}`}
          aria-hidden="true"
        >
          {author.image ? <img src={author.image} alt="" loading="lazy" /> : authorInitials}
        </span>
        <span className={styles.authorInfo}>
          <span className={styles.authorName}>{author.name}</span>
          <span className={styles.authorRole}>{author.title}</span>
          {(author.social?.linkedin || author.social?.x || author.social?.github) && (
            <span className={styles.authorSocialLinks}>
              {author.social.linkedin && (
                <a
                  href={author.social.linkedin}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`${author.name} on LinkedIn`}
                >
                  <FaLinkedinIn aria-hidden="true" />
                </a>
              )}
              {author.social.x && (
                <a
                  href={author.social.x}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`${author.name} on X`}
                >
                  <FaXTwitter aria-hidden="true" />
                </a>
              )}
              {author.social.github && (
                <a
                  href={author.social.github}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`${author.name} on GitHub`}
                >
                  <FaGithub aria-hidden="true" />
                </a>
              )}
            </span>
          )}
        </span>
      </div>
      <div className={styles.postSidebarMeta}>
        <span>
          <CalendarDays aria-hidden="true" />
          <time dateTime={post.frontmatter.date}>{formatDate(post.frontmatter.date)}</time>
        </span>
        <span>
          <Clock3 aria-hidden="true" />
          {post.readTime}
        </span>
      </div>
    </section>
  );

  return (
    <div className={styles.blogPage}>
      <SiteNav actions={<GitHubStarsBadge />} />

      <section className={styles.postHero}>
        <div className={styles.postHeroInner}>
          <p className={styles.postHeroCategory}>{post.frontmatter.category}</p>
          <h1 className={styles.postHeroTitle}>{post.frontmatter.title}</h1>
          <p className={styles.postHeroDek}>{post.frontmatter.description}</p>
        </div>
      </section>
      <div className={styles.postWaveDivider} aria-hidden="true">
        <svg viewBox="0 0 1200 80" fill="none" preserveAspectRatio="none">
          <path d="M0 0H1200V18C986 58 826 24 624 46C404 70 228 34 0 60V0Z" />
          <path d="M-80 34C170 58 372 54 612 40C858 26 1018 20 1280 42" />
          <path d="M-80 48C184 70 384 66 632 52C878 38 1036 34 1280 56" />
        </svg>
      </div>

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
          <aside className={styles.postSidebar}>
            <div className={styles.sidebarSticky}>
              {renderAuthorPanel('written-by-heading')}

              {post.toc.length > 0 && (
                <section className={styles.tocPanel} aria-labelledby="on-this-page-heading">
                  <h2 id="on-this-page-heading" className={styles.sidebarTitle}>
                    On this page
                  </h2>
                  <BlogTableOfContents items={post.toc} />
                </section>
              )}
            </div>
          </aside>

          <div className={styles.postMain}>
            <div className={styles.mobileAuthor}>{renderAuthorPanel('mobile-written-by-heading')}</div>

            {post.toc.length > 0 && (
              <div className={styles.mobileToc}>
                <div className={styles.tocPanel}>
                  <h2 className={styles.sidebarTitle}>On this page</h2>
                  <BlogTableOfContents items={post.toc} />
                </div>
              </div>
            )}

            <article className={styles.article}>
              <MDXContent components={mdxComponents} />
            </article>
          </div>
        </div>
      </main>

      {otherPosts.length > 0 && (
        <section className={styles.articleFooter} aria-labelledby="continue-reading-heading">
          <div className={styles.articleFooterWave} aria-hidden="true">
            <svg viewBox="0 0 1200 80" fill="none" preserveAspectRatio="none">
              <path d="M0 0H1200V18C986 58 826 24 624 46C404 70 228 34 0 60V0Z" />
              <path d="M-80 34C170 58 372 54 612 40C858 26 1018 20 1280 42" />
              <path d="M-80 48C184 70 384 66 632 52C878 38 1036 34 1280 56" />
            </svg>
          </div>
          <div className={styles.articleFooterInner}>
            <div className={styles.articleFooterHeader}>
              <h2 id="continue-reading-heading" className={styles.listTitle}>
                More posts
              </h2>
              <a href="/feed.xml" className={styles.rssIconLink} aria-label="RSS feed">
                <Rss aria-hidden="true" />
              </a>
            </div>
            <div className={styles.postGrid}>
              {otherPosts.map((relatedPost) => (
                <article key={relatedPost.slug}>
                  <Link href={`/blog/${relatedPost.slug}`} className={styles.postCard}>
                    <span className={styles.postCardText}>
                      <h3 className={styles.postCardTitle}>{relatedPost.frontmatter.title}</h3>
                      <span className={styles.postCardByline}>
                        By {relatedPost.frontmatter.author} - {formatFooterReadTime(relatedPost.readTime)}
                      </span>
                    </span>
                    <time className={styles.postCardDate} dateTime={relatedPost.frontmatter.date}>
                      {formatDate(relatedPost.frontmatter.date)}
                    </time>
                  </Link>
                </article>
              ))}
            </div>
          </div>
        </section>
      )}

      <Waitlist />

      <SiteFooter />
    </div>
  );
}
