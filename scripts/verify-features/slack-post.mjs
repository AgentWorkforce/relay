#!/usr/bin/env node

import { readFileSync } from 'node:fs';

import { SlackClient } from '@relayflows/slack-primitive';

const [channel, textFile] = process.argv.slice(2);
if (!channel || !textFile) {
  console.error('Usage: slack-post.mjs <channel> <text-file>');
  process.exitCode = 2;
} else {
  const text = readFileSync(textFile, 'utf8');
  const client = new SlackClient({
    runtime: 'cloud-relay',
    cloudApiUrl: process.env.CLOUD_API_URL,
    cloudApiToken: process.env.CLOUD_API_TOKEN,
  });

  try {
    const out = await client.postMessage({ channel, text, unfurl: false });
    console.log(`SLACK_POSTED channel=${out.channel} ts=${out.ts}`);
  } catch (error) {
    const code = error?.code ?? 'unknown';
    console.log(`SLACK_ERROR ${code}: ${error?.message ?? String(error)}`);
    process.exitCode = 1;
  }
}
