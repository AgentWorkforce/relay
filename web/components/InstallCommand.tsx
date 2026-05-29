'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

import s from '../app/landing.module.css';

const INSTALL_COMMAND = 'npm install @agent-relay/sdk';
const AGENT_SETUP_PROMPT = `Add Agent Relay to this project.

First inspect the README, package manager files, app entrypoints, worker scripts, existing agent/session/harness code, and test commands. Then propose the smallest integration that fits this project.

Ask me only for choices you cannot infer:
- Which agents or harnesses should join the workspace?
- Which messages should be channels, direct messages, or thread replies?
- How should inbound messages be delivered: immediate, next-message, next-tool-call, on-idle, or manual?
- Which events should Agent Relay observe: status changes, file edits, terminal output, tool calls, or custom app events?
- Which SDK actions should agents be able to call, and who is allowed to call them?
- Which command should prove the integration works?

Use the existing package manager to install @agent-relay/sdk. Wire the three Agent Relay surfaces:
1. Messaging: create or join a workspace, register sessions, send one message, and listen for message events.
2. Delivery: implement how Relay messages reach each session and how delivery is accepted, deferred, failed, or acknowledged.
3. Actions: register at least one useful project action with a Zod input schema and a structured result.

Keep changes minimal, follow existing project patterns, run the build/typecheck/tests, and summarize what works plus any remaining product decisions.`;
const AGENT_SETUP_PROMPT_PREVIEW = `${AGENT_SETUP_PROMPT.replace(/\s+/g, ' ').slice(0, 88)}...`;

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back for embedded browsers that expose clipboard without granting write access.
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

export function InstallCommand() {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await copyText(INSTALL_COMMAND);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <button className={s.installCommand} type="button" onClick={handleCopy} aria-label="Copy install command">
      <span className={s.installPrompt}>$</span>
      <code>{INSTALL_COMMAND}</code>
      <span className={s.installCopy}>
        {copied ? (
          <>
            <Check aria-hidden="true" />
            Copied
          </>
        ) : (
          <>
            <Copy aria-hidden="true" />
            Copy
          </>
        )}
      </span>
    </button>
  );
}

export function AgentSetupPrompt() {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await copyText(AGENT_SETUP_PROMPT);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <button className={s.agentPromptCopy} type="button" onClick={handleCopy} aria-label="Copy agent setup prompt">
      <span className={s.agentPromptText}>
        <span className={s.agentPromptPreview}>{AGENT_SETUP_PROMPT_PREVIEW}</span>
      </span>
      <span className={s.agentPromptHover} aria-hidden="true">
        <span className={s.agentPromptHoverTitle}>Copy prompt</span>
        <span className={s.agentPromptHoverBody}>{AGENT_SETUP_PROMPT}</span>
      </span>
      <span className={s.agentPromptCta}>
        {copied ? (
          <>
            <Check aria-hidden="true" />
            Copied
          </>
        ) : (
          <>
            <Copy aria-hidden="true" />
            Copy prompt
          </>
        )}
      </span>
    </button>
  );
}
