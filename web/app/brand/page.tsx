import type { Metadata } from 'next';

import { SiteFooter } from '../../components/SiteFooter';
import { SiteNav } from '../../components/SiteNav';
import { BrandShowcase } from './BrandShowcase';

export const metadata: Metadata = {
  title: 'Brand Colors',
  description:
    'Interactive Agent Relay brand palette and component showcase.',
};

export default function BrandPage() {
  return (
    <>
      <SiteNav />
      <BrandShowcase />
      <SiteFooter />
    </>
  );
}
