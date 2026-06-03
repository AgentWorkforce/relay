import type { Metadata } from 'next';
import { PostHogProvider } from '@posthog/next';
import { Geist_Mono, Inter, Sora } from 'next/font/google';
import type { ReactNode } from 'react';

import { defaultOgImage } from '../lib/og-meta';
import { POSTHOG_HOST, SITE_URL } from '../lib/site';
import { WebsitePostHogPageView } from './PostHogPageView';
import './globals.css';

const inter = Inter({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const sora = Sora({
  variable: '--font-heading',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  applicationName: 'Agent Relay',
  title: {
    default: 'Agent Relay',
    template: '%s | Agent Relay',
  },
  description:
    'Add channels, DMs, durable delivery, event listeners, and Zod-typed actions to any agent runtime.',
  keywords: [
    'Agent Relay',
    'multi-agent',
    'agent communication',
    'MCP',
    'AI SDK',
    'agent relay',
    'headless slack for agents',
    'agent actions',
    'agent delivery',
  ],
  robots: {
    index: true,
    follow: true,
  },
  openGraph: {
    siteName: 'Agent Relay',
    type: 'website',
    locale: 'en_US',
    images: [defaultOgImage()],
  },
  icons: {
    icon: '/favicon.svg',
  },
  twitter: {
    card: 'summary_large_image',
    images: [defaultOgImage().url],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const postHogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const content = postHogKey ? (
    <PostHogProvider
      clientOptions={{
        api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? POSTHOG_HOST,
        autocapture: true,
        capture_exceptions: true,
        capture_heatmaps: true,
        capture_pageleave: true,
      }}
    >
      <WebsitePostHogPageView />
      {children}
    </PostHogProvider>
  ) : (
    children
  );

  return (
    <html lang="en" data-theme="dark">
      <body className={`${inter.variable} ${geistMono.variable} ${sora.variable}`} suppressHydrationWarning>
        {content}
      </body>
    </html>
  );
}
