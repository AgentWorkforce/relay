'use client';

import type React from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  Link2,
} from 'lucide-react';
import { SiClaude, SiOpenai } from 'react-icons/si';

import styles from './docs.module.css';

type DocsPageActionsProps = {
  title: string;
  pageUrl: string;
  markdownPath: string;
  markdownUrl: string;
};

type ActionItem = {
  title: string;
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
  const [copiedAction, setCopiedAction] = useState<'markdown' | 'markdown-link' | null>(null);
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
    if (!copiedAction) return;

    const timeoutId = window.setTimeout(() => setCopiedAction(null), 1800);
    return () => window.clearTimeout(timeoutId);
  }, [copiedAction]);

  async function handleCopyMarkdown() {
    try {
      const response = await fetch(markdownPath, {
        headers: { Accept: 'text/markdown' },
      });

      if (!response.ok) {
        throw new Error(`Failed to load markdown: ${response.status}`);
      }

      const markdown = (await response.text()).replace(/\r\n/g, '\n').trimEnd();
      await copyToClipboard(`${markdown}\n`);
      setCopiedAction('markdown');
      setOpen(false);
    } catch {
      window.open(markdownPath, '_blank', 'noopener,noreferrer');
      setOpen(false);
    }
  }

  async function handleCopyMarkdownLink() {
    try {
      await copyToClipboard(markdownUrl);
      setCopiedAction('markdown-link');
      setOpen(false);
    } catch {
      window.open(markdownUrl, '_blank', 'noopener,noreferrer');
      setOpen(false);
    }
  }

  const prompt = encodeURIComponent(buildPrompt(title, pageUrl, markdownUrl));
  const actionItems: ActionItem[] = [
    {
      title: 'Open in ChatGPT',
      href: `https://chatgpt.com/?q=${prompt}`,
      icon: SiOpenai,
    },
    {
      title: 'Open in Claude',
      href: `https://claude.ai/new?q=${prompt}`,
      icon: SiClaude,
    },
  ];

  return (
    <div className={styles.pageActions} ref={containerRef}>
      <div className={styles.pageActionButton}>
        <button
          type="button"
          className={styles.pageActionPrimary}
          onClick={handleCopyMarkdown}
          aria-label="Copy markdown for this page"
        >
          <Copy className={styles.pageActionPrimaryIcon} />
          <span>{copiedAction === 'markdown' ? 'Copied' : 'Copy Markdown'}</span>
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
            onClick={handleCopyMarkdown}
            role="menuitem"
          >
            <span className={styles.pageActionIconFrame}>
              {copiedAction === 'markdown' ? (
                <Check className={styles.pageActionItemIcon} />
              ) : (
                <Copy className={styles.pageActionItemIcon} />
              )}
            </span>
            <span className={styles.pageActionCopyBody}>
              <span className={styles.pageActionItemTitle}>
                {copiedAction === 'markdown' ? 'Copied Markdown' : 'Copy Markdown'}
              </span>
            </span>
          </button>

          <button
            type="button"
            className={styles.pageActionItem}
            onClick={handleCopyMarkdownLink}
            role="menuitem"
          >
            <span className={styles.pageActionIconFrame}>
              {copiedAction === 'markdown-link' ? (
                <Check className={styles.pageActionItemIcon} />
              ) : (
                <Link2 className={styles.pageActionItemIcon} />
              )}
            </span>
            <span className={styles.pageActionCopyBody}>
              <span className={styles.pageActionItemTitle}>
                {copiedAction === 'markdown-link' ? 'Copied Markdown Link' : 'Copy link to Markdown'}
              </span>
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
                </span>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}
