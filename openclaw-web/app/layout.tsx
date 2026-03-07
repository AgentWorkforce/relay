import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import type { ReactNode } from 'react';

import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL('https://agentrelay.dev'),
  applicationName: 'Agent Relay for OpenClaw',
  title: {
    default: 'Agent Relay for OpenClaw',
    template: '%s | Agent Relay',
  },
  description:
    'Agent Relay connects OpenClaw instances with real-time messaging, channels, DMs, threads, reactions, and guided setup flows.',
  keywords: [
    'Agent Relay',
    'OpenClaw',
    'multi-agent messaging',
    'agent communication',
    'MCP',
    'OpenClaw setup',
    'agent relay',
  ],
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
    card: 'summary',
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body>
    </html>
  );
}
