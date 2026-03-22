import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { UseCasePage } from '../../../components/UseCasePage';
import { DEFAULT_OG_IMAGE, sitePath, siteUrl } from '../../../lib/site';
import { useCasePageMap, useCasePages } from '../../../lib/use-cases';

type PageProps = {
  params: Promise<{
    slug: string;
  }>;
};

export const dynamic = 'force-static';

export function generateStaticParams() {
  return useCasePages.map((page) => ({ slug: page.slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const page = useCasePageMap.get(slug);

  if (!page) {
    return {};
  }

  const path = `/use-cases/${page.slug}`;

  return {
    title: page.title,
    description: page.description,
    keywords: page.keywords,
    alternates: {
      canonical: sitePath(path),
    },
    openGraph: {
      title: page.title,
      description: page.description,
      url: siteUrl(path),
      type: 'article',
      images: [
        {
          url: DEFAULT_OG_IMAGE,
          width: 1200,
          height: 630,
          alt: page.title,
        },
      ],
    },
    twitter: {
      title: page.title,
      description: page.description,
      card: 'summary_large_image',
      images: [DEFAULT_OG_IMAGE],
    },
  };
}

export default async function UseCaseRoute({ params }: PageProps) {
  const { slug } = await params;
  const page = useCasePageMap.get(slug);

  if (!page) notFound();

  return <UseCasePage page={page} />;
}
