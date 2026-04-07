import { ImageResponse } from 'next/og';
import { notFound } from 'next/navigation';

import { getPost } from '../../../lib/blog';
import { SITE_HOST } from '../../../lib/site';

export const runtime = 'nodejs';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'Agent Relay blog post';

type PageProps = {
  params: Promise<{ slug: string }>;
};

export default async function BlogPostOpenGraphImage({ params }: PageProps) {
  const { slug } = await params;
  const post = getPost(slug);

  if (!post) {
    notFound();
  }

  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        position: 'relative',
        background: 'linear-gradient(145deg, #f8fbff 0%, #eef5fb 40%, #dbe8f4 100%)',
        color: '#102033',
        fontFamily: 'Inter, system-ui, sans-serif',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 32,
          borderRadius: 28,
          border: '1px solid rgba(16, 32, 51, 0.08)',
          background: 'rgba(255,255,255,0.72)',
          boxShadow: '0 30px 80px rgba(16, 32, 51, 0.08)',
        }}
      />

      <div
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '56px 64px',
          width: '100%',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 22,
            maxWidth: 920,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
            }}
          >
            <span
              style={{
                display: 'flex',
                padding: '10px 16px',
                borderRadius: 999,
                background: 'rgba(53, 117, 170, 0.12)',
                color: '#1e5d8d',
                fontSize: 22,
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
              }}
            >
              {post.frontmatter.category}
            </span>
            <span
              style={{
                color: '#62758a',
                fontSize: 24,
              }}
            >
              {post.readTime}
            </span>
          </div>

          <div
            style={{
              fontSize: 64,
              lineHeight: 1.03,
              fontWeight: 700,
              letterSpacing: '-0.05em',
              display: 'flex',
              maxWidth: 930,
            }}
          >
            {post.frontmatter.title}
          </div>

          <div
            style={{
              fontSize: 28,
              lineHeight: 1.5,
              color: '#44566a',
              display: 'flex',
              maxWidth: 900,
            }}
          >
            {post.frontmatter.description}
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 16,
            }}
          >
            <div
              style={{
                width: 52,
                height: 52,
                borderRadius: '50%',
                background: '#1e5d8d',
                color: '#ffffff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 22,
                fontWeight: 700,
              }}
            >
              {post.frontmatter.author[0]}
            </div>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              <span
                style={{
                  fontSize: 18,
                  color: '#62758a',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                }}
              >
                Written by
              </span>
              <span style={{ fontSize: 26, fontWeight: 600 }}>{post.frontmatter.author}</span>
            </div>
          </div>

          <div
            style={{
              fontSize: 24,
              color: '#1e5d8d',
              fontWeight: 600,
            }}
          >
            {SITE_HOST}
          </div>
        </div>
      </div>
    </div>,
    { ...size }
  );
}
