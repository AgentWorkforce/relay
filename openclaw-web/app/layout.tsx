import './globals.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

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
  twitter: {
    card: 'summary',
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
