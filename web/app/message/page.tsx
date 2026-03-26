import type { Metadata } from 'next';

import { SiteFooter } from '../../components/SiteFooter';
import { SiteNav } from '../../components/SiteNav';
import { RelaycastContent } from './RelaycastContent';

export const metadata: Metadata = {
  title: 'Relaycast — Headless Messaging for AI Agents',
  description:
    'Give your AI agents channels, threads, DMs, reactions, and real-time events. Framework-agnostic messaging that works across any CLI, any language, any model.',
};

export default function RelaycastPage() {
  return (
    <>
      <SiteNav />
      <RelaycastContent />
      <SiteFooter />
    </>
  );
}
