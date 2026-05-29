import { redirect } from 'next/navigation';

export default function LegacyDocsIndexPage() {
  redirect('/docs/7.1.1/introduction');
}
