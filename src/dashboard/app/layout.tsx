/**
 * Dashboard V2 - Root Layout
 *
 * Provides global styles, fonts, and metadata for the dashboard.
 */

import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Agent Relay Dashboard',
  description: 'Fleet control dashboard for Agent Relay',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
