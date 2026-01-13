'use client';

import React from 'react';
import Link from 'next/link';
import { useParams, notFound } from 'next/navigation';
import { getBlogPost, getRecentPosts } from '../../../landing/blogData';
import '../../../landing/styles.css';
import { LogoIcon } from '../../../react-components/Logo';

export default function BlogPostPage() {
  const params = useParams();
  const slug = params.slug as string;
  const post = getBlogPost(slug);

  if (!post) {
    notFound();
    return null; // TypeScript needs this even though notFound() never returns
  }

  const recentPosts = getRecentPosts(3).filter((p) => p.slug !== slug);

  return (
    <div className="landing-page blog-page">
      <BlogNavigation />

      <main className="blog-post-main">
        <article className="blog-article">
          <header className="blog-article-header">
            <Link href="/blog" className="blog-back-link">
              <span>←</span>
              <span>Back to Blog</span>
            </Link>

            <div className="blog-article-meta">
              <span className="blog-date">{formatDate(post.date)}</span>
              <span className="blog-divider">·</span>
              <span className="blog-read-time">{post.readTime}</span>
              <span className="blog-divider">·</span>
              <span className="blog-author">{post.author}</span>
            </div>

            <h1 className="blog-article-title">{post.title}</h1>

            <div className="blog-article-tags">
              {post.tags.map((tag) => (
                <span key={tag} className="blog-tag">{tag}</span>
              ))}
            </div>
          </header>

          <div className="blog-article-content">
            <MarkdownRenderer content={post.content} />
          </div>
        </article>

        {recentPosts.length > 0 && (
          <aside className="blog-sidebar">
            <h3>More Articles</h3>
            <div className="blog-sidebar-posts">
              {recentPosts.map((p) => (
                <Link key={p.slug} href={`/blog/${p.slug}`} className="blog-sidebar-post">
                  <span className="sidebar-post-title">{p.title}</span>
                  <span className="sidebar-post-date">{formatDate(p.date)}</span>
                </Link>
              ))}
            </div>
          </aside>
        )}
      </main>

      <BlogFooter />
    </div>
  );
}

function BlogNavigation() {
  return (
    <nav className="nav scrolled">
      <div className="nav-inner">
        <Link href="/" className="nav-logo">
          <LogoIcon size={28} withGlow={true} />
          <span className="logo-text">Agent Relay</span>
        </Link>

        <div className="nav-links">
          <Link href="/#demo">Demo</Link>
          <Link href="/#features">Features</Link>
          <Link href="/#pricing">Pricing</Link>
          <Link href="/docs" className="nav-docs">Docs</Link>
        </div>

        <div className="nav-actions">
          <Link href="/login" className="btn-ghost">Sign In</Link>
          <Link href="/signup" className="btn-primary">Get Started</Link>
        </div>
      </div>
    </nav>
  );
}

function BlogFooter() {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <div className="footer-brand">
          <Link href="/" className="footer-logo">
            <LogoIcon size={24} withGlow={true} />
            <span className="logo-text">Agent Relay</span>
          </Link>
          <p>Orchestrate AI agents like a symphony.</p>
        </div>

        <div className="footer-links">
          <div className="footer-column">
            <h4>Product</h4>
            <Link href="/#features">Features</Link>
            <Link href="/#pricing">Pricing</Link>
            <Link href="/docs">Documentation</Link>
            <Link href="/changelog">Changelog</Link>
          </div>
          <div className="footer-column">
            <h4>Company</h4>
            <Link href="/about">About</Link>
            <Link href="/blog">Blog</Link>
            <Link href="/careers">Careers</Link>
            <Link href="/contact">Contact</Link>
          </div>
          <div className="footer-column">
            <h4>Legal</h4>
            <Link href="/privacy">Privacy</Link>
            <Link href="/terms">Terms</Link>
            <Link href="/security">Security</Link>
          </div>
        </div>
      </div>

      <div className="footer-bottom">
        <p>© 2026 Agent Relay. All rights reserved.</p>
      </div>
    </footer>
  );
}

/**
 * Simple markdown renderer for blog content
 * Handles headings, code blocks, paragraphs, lists, and inline formatting
 */
function MarkdownRenderer({ content }: { content: string }) {
  const lines = content.split('\n');
  const elements: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code blocks
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      elements.push(
        <pre key={i} className="blog-code-block" data-lang={lang}>
          <code>{codeLines.join('\n')}</code>
        </pre>
      );
      i++;
      continue;
    }

    // Headings
    if (line.startsWith('## ')) {
      elements.push(<h2 key={i}>{renderInline(line.slice(3))}</h2>);
      i++;
      continue;
    }
    if (line.startsWith('### ')) {
      elements.push(<h3 key={i}>{renderInline(line.slice(4))}</h3>);
      i++;
      continue;
    }
    if (line.startsWith('# ')) {
      // Skip h1 as we render it in the header
      i++;
      continue;
    }

    // Horizontal rule
    if (line.match(/^-{3,}$/)) {
      elements.push(<hr key={i} className="blog-hr" />);
      i++;
      continue;
    }

    // Unordered lists
    if (line.match(/^[-*] /)) {
      const listItems: string[] = [];
      while (i < lines.length && lines[i].match(/^[-*] /)) {
        listItems.push(lines[i].slice(2));
        i++;
      }
      elements.push(
        <ul key={i} className="blog-list">
          {listItems.map((item, idx) => (
            <li key={idx}>{renderInline(item)}</li>
          ))}
        </ul>
      );
      continue;
    }

    // Ordered lists
    if (line.match(/^\d+\. /)) {
      const listItems: string[] = [];
      while (i < lines.length && lines[i].match(/^\d+\. /)) {
        listItems.push(lines[i].replace(/^\d+\. /, ''));
        i++;
      }
      elements.push(
        <ol key={i} className="blog-list blog-list-ordered">
          {listItems.map((item, idx) => (
            <li key={idx}>{renderInline(item)}</li>
          ))}
        </ol>
      );
      continue;
    }

    // Empty lines
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraphs
    elements.push(<p key={i}>{renderInline(line)}</p>);
    i++;
  }

  return <>{elements}</>;
}

/**
 * Render inline markdown: bold, italic, code, links
 */
function renderInline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // Inline code
    const codeMatch = remaining.match(/^`([^`]+)`/);
    if (codeMatch) {
      parts.push(<code key={key++} className="blog-inline-code">{codeMatch[1]}</code>);
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }

    // Bold
    const boldMatch = remaining.match(/^\*\*([^*]+)\*\*/);
    if (boldMatch) {
      parts.push(<strong key={key++}>{boldMatch[1]}</strong>);
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // Italic
    const italicMatch = remaining.match(/^\*([^*]+)\*/);
    if (italicMatch) {
      parts.push(<em key={key++}>{italicMatch[1]}</em>);
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }

    // Links
    const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      parts.push(
        <a key={key++} href={linkMatch[2]} target="_blank" rel="noopener noreferrer" className="blog-link">
          {linkMatch[1]}
        </a>
      );
      remaining = remaining.slice(linkMatch[0].length);
      continue;
    }

    // Regular text - find next special character
    const nextSpecial = remaining.search(/[`*\[]/);
    if (nextSpecial === -1) {
      parts.push(remaining);
      break;
    } else if (nextSpecial === 0) {
      // Special char doesn't match pattern, treat as regular
      parts.push(remaining[0]);
      remaining = remaining.slice(1);
    } else {
      parts.push(remaining.slice(0, nextSpecial));
      remaining = remaining.slice(nextSpecial);
    }
  }

  return parts.length === 1 ? parts[0] : <>{parts}</>;
}

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}
