import type { Metadata } from 'next';

import { SiteFooter } from '../../components/SiteFooter';
import { SiteNav } from '../../components/SiteNav';
import { RelayfileContent } from './RelayfileContent';

export const metadata: Metadata = {
  title: 'Relayfile — Headless Filesystem for AI Agents',
  description:
    'Give your AI agents a shared filesystem for reading, writing, watching, and coordinating file changes without building storage infrastructure.',
};

export default function RelayfilePage() {
  return (
    <>
      <SiteNav />
      <RelayfileContent />
      <SiteFooter />
    </>
  );
}
