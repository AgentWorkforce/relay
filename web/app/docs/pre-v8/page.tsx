import { redirect } from 'next/navigation';

export default function LegacyDocsRedirectPage() {
  redirect('/docs/7.1.1/introduction');
}
