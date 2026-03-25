import type { Metadata } from 'next';
import { Geist_Mono, Inter, Sora } from 'next/font/google';
import type { ReactNode } from 'react';

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
    'Spawn, coordinate, and connect AI agents from TypeScript or Python.',
  keywords: [
    'Agent Relay',
    'multi-agent',
    'agent communication',
    'MCP',
    'AI SDK',
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
    card: 'summary_large_image',
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.variable} ${geistMono.variable} ${sora.variable}`}>
        {children}
      </body>
    </html>
  );
}
