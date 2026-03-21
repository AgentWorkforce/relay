import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { NextResponse } from 'next/server';
import { Resource } from 'sst';

const MAX_EMAIL_LENGTH = 320;
const LOCAL_PART_CHARS = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/;
const DOMAIN_CHARS = /^[a-z0-9.-]+$/;
type WaitlistResource = typeof Resource & { Waitlist: { name: string } };

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function getWaitlistTableName(): string {
  return (Resource as WaitlistResource).Waitlist.name;
}

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

    await client.send(
      new PutCommand({
        TableName: getWaitlistTableName(),
        Item: {
          email,
          joinedAt: new Date().toISOString(),
        },
        ConditionExpression: 'attribute_not_exists(email)',
      })
    ).catch((err: Error & { name?: string }) => {
      // ConditionalCheckFailedException means email already exists — that's fine
      if (err.name !== 'ConditionalCheckFailedException') throw err;
    });

    return NextResponse.json({ message: 'Added to waitlist', email });
  } catch {
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}

export async function GET() {
  try {
    const result = await client.send(
      new ScanCommand({
        TableName: getWaitlistTableName(),
        Select: 'COUNT',
      })
    );
    return NextResponse.json({ count: result.Count ?? 0 });
  } catch {
    return NextResponse.json({ count: 0 });
  }
}
