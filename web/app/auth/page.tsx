import type { Metadata } from 'next';

import { SiteFooter } from '../../components/SiteFooter';
import { SiteNav } from '../../components/SiteNav';
import { RelayauthContent } from './RelayauthContent';

export const metadata: Metadata = {
  title: 'Relayauth — Identity & Authorization for AI Agents',
  description: 'Tokens, scopes, RBAC, and audit trails for multi-agent systems.',
};

export default function RelayauthPage() {
  return (
    <>
      <SiteNav />
      <RelayauthContent />
      <SiteFooter />
    </>
  );
}
