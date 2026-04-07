import { getAllPosts } from '../../lib/blog';
import { absoluteUrl, SITE_EMAIL, SITE_NAME } from '../../lib/site';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function GET() {
  const posts = getAllPosts();
  const latestDate =
    posts[0]?.frontmatter.updatedAt ?? posts[0]?.frontmatter.date ?? new Date().toISOString();
  const feedUrl = absoluteUrl('/feed.xml');

  const items = posts
    .map((post) => {
      const postUrl = absoluteUrl(`/blog/${post.slug}`);
      const publishedAt = new Date(post.frontmatter.date).toUTCString();

      return `
        <item>
          <title>${escapeXml(post.frontmatter.title)}</title>
          <link>${postUrl}</link>
          <guid>${postUrl}</guid>
          <pubDate>${publishedAt}</pubDate>
          <description>${escapeXml(post.frontmatter.description)}</description>
          <author>${escapeXml(post.frontmatter.author)}</author>
          ${post.frontmatter.category ? `<category>${escapeXml(post.frontmatter.category)}</category>` : ''}
        </item>
      `;
    })
    .join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${SITE_NAME} Blog</title>
    <link>${absoluteUrl('/blog')}</link>
    <description>Essays, playbooks, and product thinking on multi-agent systems and AI coordination.</description>
    <language>en-us</language>
    <lastBuildDate>${new Date(latestDate).toUTCString()}</lastBuildDate>
    <atom:link href="${feedUrl}" rel="self" type="application/rss+xml" />
    <managingEditor>${escapeXml(SITE_EMAIL)}</managingEditor>
    ${items}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 's-maxage=3600, stale-while-revalidate=86400',
    },
  });
}
