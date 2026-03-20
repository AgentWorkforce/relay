import { NextResponse } from 'next/server';

const WAITLIST_WEBHOOK_URL = process.env.WAITLIST_WEBHOOK_URL?.trim();
const MAX_EMAIL_LENGTH = 320;
const LOCAL_PART_CHARS = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/;
const DOMAIN_CHARS = /^[a-z0-9.-]+$/;

function hasSingleAtSign(email: string): boolean {
  const atIndex = email.indexOf('@');
  return atIndex > 0 && atIndex === email.lastIndexOf('@') && atIndex < email.length - 1;
}

function isValidDomain(domain: string): boolean {
  if (!domain || domain.startsWith('.') || domain.endsWith('.') || !domain.includes('.')) {
    return false;
  }

  if (!DOMAIN_CHARS.test(domain)) {
    return false;
  }

  return domain
    .split('.')
    .every((label) => label.length > 0 && !label.startsWith('-') && !label.endsWith('-'));
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const email = value.trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL_LENGTH || email.includes(' ') || !hasSingleAtSign(email)) {
    return null;
  }

  const [local, domain] = email.split('@');
  if (!local || !LOCAL_PART_CHARS.test(local) || !isValidDomain(domain)) {
    return null;
  }

  return email;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { email?: unknown };
    const email = normalizeEmail(body.email);

    if (!email) {
      return NextResponse.json({ error: 'Invalid email address' }, { status: 400 });
    }

    if (!WAITLIST_WEBHOOK_URL) {
      return NextResponse.json({ error: 'Waitlist is not configured' }, { status: 503 });
    }

    const response = await fetch(WAITLIST_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email }),
      cache: 'no-store',
    });

    if (!response.ok) {
      return NextResponse.json({ error: 'Unable to join waitlist' }, { status: 502 });
    }

    return NextResponse.json({ message: 'Added to waitlist' });
  } catch {
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ configured: Boolean(WAITLIST_WEBHOOK_URL) });
}
