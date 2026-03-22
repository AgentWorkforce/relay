import { permanentRedirect } from 'next/navigation';

type PageProps = {
  params: Promise<{
    slug: string;
  }>;
};

export default async function LegacyOpenClawUseCasePage({ params }: PageProps) {
  const { slug } = await params;
  permanentRedirect(`/use-cases/${encodeURIComponent(slug)}`);
}
