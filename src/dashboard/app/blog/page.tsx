'use client';

import React from 'react';
import Link from 'next/link';
import { BLOG_POSTS } from '../../landing/blogData';
import '../../landing/styles.css';
import { LogoIcon } from '../../react-components/Logo';

export default function BlogIndexPage() {
  return (
    <div className="landing-page blog-page">
      <BlogNavigation />

      <main className="blog-main">
        <div className="blog-header">
          <span className="section-tag">Blog</span>
          <h1>Insights & Updates</h1>
          <p>Thoughts on AI agent orchestration, multi-agent systems, and building the future of software development.</p>
        </div>

        <div className="blog-grid">
          {BLOG_POSTS.map((post) => (
            <Link key={post.slug} href={`/blog/${post.slug}`} className="blog-card">
              <div className="blog-card-content">
                <div className="blog-card-meta">
                  <span className="blog-date">{formatDate(post.date)}</span>
                  <span className="blog-divider">·</span>
                  <span className="blog-read-time">{post.readTime}</span>
                </div>
                <h2 className="blog-card-title">{post.title}</h2>
                <p className="blog-card-excerpt">{post.excerpt}</p>
                <div className="blog-card-tags">
                  {post.tags.map((tag) => (
                    <span key={tag} className="blog-tag">{tag}</span>
                  ))}
                </div>
              </div>
              <div className="blog-card-arrow">→</div>
            </Link>
          ))}
        </div>
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

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}
