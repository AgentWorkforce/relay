import type { Metadata } from 'next';

import { SiteFooter } from '../../components/SiteFooter';
import { SiteNav } from '../../components/SiteNav';
import { ScheduleContent } from './ScheduleContent';

export const metadata: Metadata = {
  title: 'RelayCron — Cron Scheduling for AI Agents',
  description:
    'Reliable cron scheduling for AI agents. Cron expressions, webhook delivery, WebSocket real-time events, and execution logs — all built on Cloudflare Durable Objects.',
};

export default function SchedulePage() {
  return (
    <>
      <SiteNav />
      <ScheduleContent />
      <SiteFooter />
    </>
  );
}
