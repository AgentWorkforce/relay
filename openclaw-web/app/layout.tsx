import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import type { ReactNode } from 'react';

import './globals.css';
import { DEFAULT_DESCRIPTION, DEFAULT_OG_IMAGE, PRODUCT_NAME, SITE_NAME, SITE_URL, sitePath, siteUrl } from '../lib/site';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  applicationName: PRODUCT_NAME,
  title: {
    default: PRODUCT_NAME,
    template: `%s | ${SITE_NAME}`,
  },
  description: DEFAULT_DESCRIPTION,
  keywords: [
    'Agent Relay',
    'OpenClaw',
    'OpenClaw setup',
    'OpenClaw messaging',
    'OpenClaw multi-agent chat',
    'multi-agent messaging',
    'agent communication',
    'AI agent collaboration',
    'MCP',
  ],
  alternates: {
    canonical: sitePath('/'),
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
      'max-video-preview': -1,
    },
  },
  openGraph: {
    siteName: SITE_NAME,
    type: 'website',
    locale: 'en_US',
    url: siteUrl('/'),
    title: PRODUCT_NAME,
    description: DEFAULT_DESCRIPTION,
    images: [
      {
        url: DEFAULT_OG_IMAGE,
        width: 1200,
        height: 630,
        alt: PRODUCT_NAME,
      },
    ],
  },
  icons: {
    icon: '/favicon.svg',
  },
  twitter: {
    card: 'summary_large_image',
    title: PRODUCT_NAME,
    description: DEFAULT_DESCRIPTION,
    images: [DEFAULT_OG_IMAGE],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body>
    </html>
  );
}
