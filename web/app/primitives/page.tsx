import type { Metadata } from 'next';

import { SiteFooter } from '../../components/SiteFooter';
import { SiteNav } from '../../components/SiteNav';
import { PrimitivesContent } from './PrimitivesContent';

export const metadata: Metadata = {
  title: 'Primitives — Auth, Files, Messaging & Scheduling for AI Agents',
  description:
    'The building blocks for agent infrastructure. Identity, shared files, real-time messaging, and cron scheduling — all through one platform.',
};

export default function PrimitivesPage() {
  return (
    <>
      <SiteNav />
      <PrimitivesContent />
      <SiteFooter />
    </>
  );
}
