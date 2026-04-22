import { ImageResponse } from 'next/og';
import { notFound } from 'next/navigation';

import { getDoc } from '../../../lib/docs';
import { SITE_HOST } from '../../../lib/site';

export const runtime = 'nodejs';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'Agent Relay docs';

type PageProps = {
  params: Promise<{ slug: string }>;
};

function deriveCategory(slug: string): string {
  const head = slug.split('-')[0]?.toLowerCase() ?? '';
  if (head === 'reference' || head === 'cli' || head === 'sdk') return 'Reference';
  if (head === 'plugin' || head === 'plugins') return 'Plugins';
  if (slug.startsWith('typescript') || slug.startsWith('python')) return 'SDK';
  if (head === 'examples' || slug.includes('example')) return 'Examples';
  if (head === 'introduction' || head === 'getting' || head === 'quickstart') return 'Getting Started';
  return 'Documentation';
}

export default async function DocsOpenGraphImage({ params }: PageProps) {
  const { slug } = await params;
  const doc = getDoc(slug);

  if (!doc) {
    notFound();
  }

  const headings = doc.toc.filter((t) => t.level <= 3).slice(0, 4);
  const category = deriveCategory(slug);
  const title = doc.frontmatter.title;
  const description = doc.frontmatter.description ?? '';

  const titleSize = title.length > 56 ? 52 : title.length > 36 ? 62 : 72;

  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        position: 'relative',
        background: '#08111A',
        backgroundImage:
          'radial-gradient(circle at 12% 14%, rgba(116,184,226,0.22) 0%, transparent 42%), radial-gradient(circle at 92% 90%, rgba(116,184,226,0.10) 0%, transparent 50%), linear-gradient(180deg, #0A1623 0%, #08111A 60%, #050C14 100%)',
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
          background: 'rgba(15, 27, 41, 0.6)',
          boxShadow: '0 30px 80px rgba(0, 0, 0, 0.5)',
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
            gap: 22,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              alignSelf: 'flex-start',
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
                fontSize: 18,
                fontWeight: 700,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
              }}
            >
              Docs · {category}
            </span>
          </div>

          <div
            style={{
              fontSize: titleSize,
              lineHeight: 1.04,
              fontWeight: 700,
              letterSpacing: '-0.05em',
              display: 'flex',
              maxWidth: 1000,
              color: '#EDF4FB',
            }}
          >
            {title}
          </div>

          {description ? (
            <div
              style={{
                fontSize: 26,
                lineHeight: 1.5,
                color: '#A8B8C8',
                display: 'flex',
                maxWidth: 980,
              }}
            >
              {description}
            </div>
          ) : null}

          {headings.length > 0 ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                marginTop: 18,
                padding: '18px 22px',
                background: 'rgba(8, 17, 26, 0.7)',
                border: '1px solid rgba(116, 184, 226, 0.18)',
                borderRadius: 14,
                maxWidth: 800,
              }}
            >
              {headings.map((h) => (
                <div
                  key={h.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    fontSize: 20,
                    color: h.level === 2 ? '#DBE5F0' : '#A8B8C8',
                    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
                  }}
                >
                  <span
                    style={{
                      color: '#74B8E2',
                      fontWeight: 700,
                      width: 38,
                    }}
                  >
                    {h.level === 2 ? '##' : '###'}
                  </span>
                  <span>{h.text}</span>
                </div>
              ))}
            </div>
          ) : null}
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
              gap: 12,
              color: '#A8B8C8',
              fontSize: 22,
              fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
            }}
          >
            <span style={{ color: '#74B8E2' }}>$</span>
            <span>/docs/{slug}</span>
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
