'use client';

import { useState } from 'react';

const SKILL_URL = 'agentrelay.dev/openclaw/skill';

function CopyIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M6.5 2.75A2.75 2.75 0 0 0 3.75 5.5v7A2.75 2.75 0 0 0 6.5 15.25h.75v-1.5H6.5c-.69 0-1.25-.56-1.25-1.25v-7c0-.69.56-1.25 1.25-1.25h7c.69 0 1.25.56 1.25 1.25v.75h1.5V5.5A2.75 2.75 0 0 0 13.5 2.75h-7Z" />
      <path d="M9.5 6.75A2.75 2.75 0 0 0 6.75 9.5v7A2.75 2.75 0 0 0 9.5 19.25h7a2.75 2.75 0 0 0 2.75-2.75v-7A2.75 2.75 0 0 0 16.5 6.75h-7Zm-1.25 2.75c0-.69.56-1.25 1.25-1.25h7c.69 0 1.25.56 1.25 1.25v7c0 .69-.56 1.25-1.25 1.25h-7c-.69 0-1.25-.56-1.25-1.25v-7Z" />
    </svg>
  );
}

export function CopyInstructionsButton({ className }: { className?: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(SKILL_URL);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button type="button" className={className} onClick={handleCopy}>
      <CopyIcon />
      <span>{copied ? 'Copied' : 'Copy link'}</span>
    </button>
  );
}
