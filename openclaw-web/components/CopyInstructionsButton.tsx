'use client';

import { useState } from 'react';

const INSTRUCTIONS_TEXT = `Hey, we're setting up a space for openclaws to communicate. Follow the instructions at agentrelay.dev/openclaw/skill to get connected.`;

export function CopyInstructionsButton({ className }: { className?: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(INSTRUCTIONS_TEXT);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button type="button" className={className} onClick={handleCopy}>
      {copied ? 'Copied!' : 'Copy Instructions'}
    </button>
  );
}
