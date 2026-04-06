import { postHogMiddleware } from '@posthog/next';
import { NextResponse, type NextRequest } from 'next/server';

const DEFAULT_POSTHOG_HOST = 'https://i.agentrelay.dev';

const postHog = process.env.NEXT_PUBLIC_POSTHOG_KEY
  ? postHogMiddleware({
      proxy: { host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? DEFAULT_POSTHOG_HOST },
    })
  : null;

export default function middleware(request: NextRequest) {
  if (!postHog) return NextResponse.next();
  return postHog(request);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
