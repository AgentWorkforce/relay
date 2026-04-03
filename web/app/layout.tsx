import type { Metadata } from 'next';
import { PostHogProvider } from '@posthog/next';
import { Geist_Mono, Inter, Sora } from 'next/font/google';
import type { ReactNode } from 'react';

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
  metadataBase: new URL('https://agentrelay.dev'),
  applicationName: 'Agent Relay',
  title: {
    default: 'Agent Relay',
    template: '%s | Agent Relay',
  },
  description:
    'Build AI systems where agents communicate, share context, and coordinate work through channels, messages, files, and workflows.',
  keywords: ['Agent Relay', 'multi-agent', 'agent communication', 'MCP', 'AI SDK', 'agent relay', 'slack for agents'],
  robots: {
    index: true,
    follow: true,
  },
  openGraph: {
    siteName: 'Agent Relay',
    type: 'website',
    locale: 'en_US',
  },
  icons: {
    icon: '/favicon.svg',
  },
  twitter: {
    card: 'summary_large_image',
  },
};

const themeScript = `
  (function () {
    try {
      var key = 'agentrelay-theme';
      var stored = localStorage.getItem(key);
      if (stored === 'dark' || stored === 'light') {
        document.documentElement.dataset.theme = stored;
        document.documentElement.style.colorScheme = stored;
      } else {
        document.documentElement.dataset.theme = 'dark';
        document.documentElement.style.colorScheme = 'dark';
      }
    } catch (error) {}
  })();
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  const postHogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const content = postHogKey ? (
    <PostHogProvider
      clientOptions={{
        api_host: '/ingest',
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
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className={`${inter.variable} ${geistMono.variable} ${sora.variable}`}>{content}</body>
    </html>
  );
}
