import { postHogMiddleware } from '@posthog/next';
import { NextResponse, type NextRequest } from 'next/server';

import { POSTHOG_HOST as DEFAULT_POSTHOG_HOST } from './lib/site';

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
