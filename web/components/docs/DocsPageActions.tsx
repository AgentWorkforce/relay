'use client';

import type React from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  FileText,
  MessageSquare,
  Search,
  Sparkles,
} from 'lucide-react';

import styles from './docs.module.css';

type DocsPageActionsProps = {
  title: string;
  pageUrl: string;
  markdownPath: string;
  markdownUrl: string;
};

type ActionItem = {
  title: string;
  description: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
};

function buildPrompt(title: string, pageUrl: string, markdownUrl: string): string {
  return [
    `I am reading the Agent Relay docs page "${title}".`,
    'Use this page as the source of truth and answer questions about it.',
    '',
    `Docs page: ${pageUrl}`,
    `Markdown: ${markdownUrl}`,
  ].join('\n');
}

async function copyToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to a DOM-based copy path for browsers that block async clipboard writes.
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  const copied = document.execCommand('copy');
  document.body.removeChild(textarea);

  if (!copied) {
    throw new Error('Clipboard copy failed');
  }
}

export function DocsPageActions({ title, pageUrl, markdownPath, markdownUrl }: DocsPageActionsProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!copied) return;

    const timeoutId = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timeoutId);
  }, [copied]);

  async function handleCopy() {
    try {
      const response = await fetch(markdownPath, {
        headers: { Accept: 'text/markdown' },
      });

      if (!response.ok) {
        throw new Error(`Failed to load markdown: ${response.status}`);
      }

      const markdown = (await response.text()).replace(/\r\n/g, '\n').trimEnd();
      await copyToClipboard(`${markdown}\n`);
      setCopied(true);
      setOpen(false);
    } catch {
      window.open(markdownPath, '_blank', 'noopener,noreferrer');
      setOpen(false);
    }
  }

  const prompt = encodeURIComponent(buildPrompt(title, pageUrl, markdownUrl));
  const actionItems: ActionItem[] = [
    {
      title: 'View as Markdown',
      description: 'View this page as plain text',
      href: markdownPath,
      icon: FileText,
    },
    {
      title: 'Open in ChatGPT',
      description: 'Ask questions about this page',
      href: `https://chatgpt.com/?q=${prompt}`,
      icon: MessageSquare,
    },
    {
      title: 'Open in Claude',
      description: 'Ask questions about this page',
      href: `https://claude.ai/new?q=${prompt}`,
      icon: Sparkles,
    },
    {
      title: 'Open in Perplexity',
      description: 'Ask questions about this page',
      href: `https://www.perplexity.ai/search?q=${prompt}`,
      icon: Search,
    },
  ];

  return (
    <div className={styles.pageActions} ref={containerRef}>
      <div className={styles.pageActionButton}>
        <button
          type="button"
          className={styles.pageActionPrimary}
          onClick={handleCopy}
          aria-label="Copy page text for pasting into an LLM"
        >
          <Copy className={styles.pageActionPrimaryIcon} />
          <span>{copied ? 'Copied' : 'Copy page'}</span>
        </button>
        <button
          type="button"
          className={styles.pageActionToggle}
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls={menuId}
          aria-haspopup="menu"
          aria-label={open ? 'Close page actions' : 'Open page actions'}
        >
          {open ? <ChevronUp className={styles.pageActionChevron} /> : <ChevronDown className={styles.pageActionChevron} />}
        </button>
      </div>

      {open && (
        <div className={styles.pageActionMenu} id={menuId} role="menu">
          <button
            type="button"
            className={styles.pageActionItem}
            onClick={handleCopy}
            role="menuitem"
          >
            <span className={styles.pageActionIconFrame}>
              {copied ? <Check className={styles.pageActionItemIcon} /> : <Copy className={styles.pageActionItemIcon} />}
            </span>
            <span className={styles.pageActionCopyBody}>
              <span className={styles.pageActionItemTitle}>{copied ? 'Copied page' : 'Copy page'}</span>
              <span className={styles.pageActionItemDescription}>Copy page text you can paste into an LLM</span>
            </span>
          </button>

          {actionItems.map((item) => {
            const Icon = item.icon;
            return (
              <a
                key={item.title}
                href={item.href}
                target="_blank"
                rel="noreferrer"
                className={styles.pageActionItem}
                role="menuitem"
                onClick={() => setOpen(false)}
              >
                <span className={styles.pageActionIconFrame}>
                  <Icon className={styles.pageActionItemIcon} />
                </span>
                <span className={styles.pageActionCopyBody}>
                  <span className={styles.pageActionItemTitle}>
                    {item.title}
                    <ExternalLink className={styles.pageActionExternal} />
                  </span>
                  <span className={styles.pageActionItemDescription}>{item.description}</span>
                </span>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}
