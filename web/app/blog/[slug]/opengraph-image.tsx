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
        background: '#08111A',
        backgroundImage:
          'radial-gradient(circle at 12% 18%, rgba(116,184,226,0.22) 0%, transparent 45%), radial-gradient(circle at 88% 92%, rgba(193,103,75,0.12) 0%, transparent 45%), linear-gradient(180deg, #0A1623 0%, #08111A 60%, #050C14 100%)',
        color: '#EDF4FB',
        fontFamily: 'Inter, system-ui, sans-serif',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 32,
          borderRadius: 28,
          border: '1px solid rgba(116, 184, 226, 0.16)',
          background: 'rgba(15, 27, 41, 0.7)',
          boxShadow: '0 30px 80px rgba(0, 0, 0, 0.45)',
        }}
      />

      <div
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '64px 72px',
          width: '100%',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 24,
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
                background: 'rgba(116, 184, 226, 0.14)',
                border: '1px solid rgba(116, 184, 226, 0.28)',
                color: '#94CBEF',
                fontSize: 20,
                fontWeight: 700,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
              }}
            >
              {post.frontmatter.category}
            </span>
            <span
              style={{
                color: '#A8B8C8',
                fontSize: 22,
              }}
            >
              {post.readTime}
            </span>
          </div>

          <div
            style={{
              fontSize: 64,
              lineHeight: 1.04,
              fontWeight: 700,
              letterSpacing: '-0.05em',
              display: 'flex',
              maxWidth: 930,
              color: '#EDF4FB',
            }}
          >
            {post.frontmatter.title}
          </div>

          <div
            style={{
              fontSize: 26,
              lineHeight: 1.5,
              color: '#A8B8C8',
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
                background: 'linear-gradient(145deg, #74B8E2 0%, #3B789F 100%)',
                color: '#08111A',
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
                  fontSize: 16,
                  color: '#77879A',
                  textTransform: 'uppercase',
                  letterSpacing: '0.1em',
                }}
              >
                Written by
              </span>
              <span style={{ fontSize: 24, fontWeight: 600, color: '#EDF4FB' }}>
                {post.frontmatter.author}
              </span>
            </div>
          </div>

          <div
            style={{
              fontSize: 22,
              color: '#74B8E2',
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
