import fs from 'node:fs';
import path from 'node:path';

import { NextResponse } from 'next/server';

const WAITLIST_FILE = path.resolve(process.cwd(), 'waitlist.json');

function readWaitlist(): string[] {
  try {
    if (fs.existsSync(WAITLIST_FILE)) {
      return JSON.parse(fs.readFileSync(WAITLIST_FILE, 'utf8'));
    }
  } catch {
    // ignore
  }
  return [];
}

function writeWaitlist(emails: string[]) {
  fs.writeFileSync(WAITLIST_FILE, JSON.stringify(emails, null, 2));
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const email = (body.email as string || '').trim().toLowerCase();

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: 'Invalid email address' }, { status: 400 });
    }

    const emails = readWaitlist();

    if (emails.includes(email)) {
      return NextResponse.json({ message: 'Already on the waitlist', email });
    }

    emails.push(email);
    writeWaitlist(emails);

    return NextResponse.json({ message: 'Added to waitlist', email });
  } catch {
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}

export async function GET() {
  const emails = readWaitlist();
  return NextResponse.json({ count: emails.length });
}
