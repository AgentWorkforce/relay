import { redirect } from 'next/navigation';

type PageProps = {
  params: Promise<{ slug: string }>;
};

export default async function LegacyDocsSlugRedirectPage({ params }: PageProps) {
  const { slug } = await params;
  redirect(`/docs/7.1.1/${slug}`);
}
