import { redirect } from 'next/navigation';

type PageProps = {
  params: Promise<{ slug: string }>;
};

export default async function V8DocsSlugRedirectPage({ params }: PageProps) {
  const { slug } = await params;
  redirect(`/docs/${slug}`);
}
