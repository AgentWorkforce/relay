import React, { useCallback, useState } from 'react';
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
// Only import languages we actually need (saves ~300KB)
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go';
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust';
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import ruby from 'react-syntax-highlighter/dist/esm/languages/prism/ruby';
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java';
import docker from 'react-syntax-highlighter/dist/esm/languages/prism/docker';

SyntaxHighlighter.registerLanguage('javascript', javascript);
SyntaxHighlighter.registerLanguage('typescript', typescript);
SyntaxHighlighter.registerLanguage('python', python);
SyntaxHighlighter.registerLanguage('bash', bash);
SyntaxHighlighter.registerLanguage('shell', bash);
SyntaxHighlighter.registerLanguage('json', json);
SyntaxHighlighter.registerLanguage('markdown', markdown);
SyntaxHighlighter.registerLanguage('yaml', yaml);
SyntaxHighlighter.registerLanguage('css', css);
SyntaxHighlighter.registerLanguage('go', go);
SyntaxHighlighter.registerLanguage('rust', rust);
SyntaxHighlighter.registerLanguage('sql', sql);
SyntaxHighlighter.registerLanguage('ruby', ruby);
SyntaxHighlighter.registerLanguage('java', java);
SyntaxHighlighter.registerLanguage('docker', docker);
SyntaxHighlighter.registerLanguage('dockerfile', docker);

/**
 * Custom theme extending oneDark to match dashboard styling
 */
const customCodeTheme = {
  ...oneDark,
  'pre[class*="language-"]': {
    ...oneDark['pre[class*="language-"]'],
    background: 'rgba(15, 23, 42, 0.8)',
    margin: '0.5rem 0',
    padding: '1rem',
    borderRadius: '0.5rem',
    border: '1px solid rgba(148, 163, 184, 0.1)',
    fontSize: '0.75rem',
    lineHeight: '1.5',
  },
  'code[class*="language-"]': {
    ...oneDark['code[class*="language-"]'],
    background: 'transparent',
    fontSize: '0.75rem',
  },
};

/**
 * CodeBlock Component - Renders syntax highlighted code
 */
interface CodeBlockProps {
  code: string;
  language: string;
}

function CodeBlock({ code, language }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }, [code]);

  // Normalize language names for syntax highlighter
  const normalizedLanguage = language.toLowerCase().replace(/^(js|jsx)$/, 'javascript')
    .replace(/^(ts|tsx)$/, 'typescript')
    .replace(/^(py)$/, 'python')
    .replace(/^(rb)$/, 'ruby')
    .replace(/^(sh|shell|zsh)$/, 'bash');

  return (
    <div className="relative group my-2">
      {/* Language badge and copy button */}
      <div className="absolute top-2 right-2 flex items-center gap-2 z-10">
        {language && language !== 'text' && (
          <span className="text-xs px-2 py-0.5 rounded bg-accent-cyan/20 text-accent-cyan font-mono">
            {language}
          </span>
        )}
        <button
          onClick={handleCopy}
          className="opacity-0 group-hover:opacity-100 transition-opacity text-xs px-2 py-1 rounded bg-bg-tertiary hover:bg-bg-card text-text-muted hover:text-text-primary border border-border-subtle"
          title="Copy code"
        >
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
      <SyntaxHighlighter
        language={normalizedLanguage}
        style={customCodeTheme}
        customStyle={{
          margin: 0,
          background: 'rgba(15, 23, 42, 0.8)',
        }}
        showLineNumbers={code.split('\n').length > 3}
        lineNumberStyle={{
          minWidth: '2.5em',
          paddingRight: '1em',
          color: 'rgba(148, 163, 184, 0.4)',
          userSelect: 'none',
        }}
      >
        {code.trim()}
      </SyntaxHighlighter>
    </div>
  );
}

/**
 * Check if a line looks like part of a table (has pipe characters)
 */
function isTableLine(line: string): boolean {
  const pipeCount = (line.match(/\|/g) || []).length;
  return pipeCount >= 2 || (line.trim().startsWith('|') && line.trim().endsWith('|'));
}

/**
 * Check if a line is a table separator (dashes and pipes)
 */
function isTableSeparator(line: string): boolean {
  return /^[\s|:-]+$/.test(line) && line.includes('-') && line.includes('|');
}

interface ContentSection {
  type: 'text' | 'table' | 'code';
  content: string;
  language?: string;
}

/**
 * Split content into text, table, and code sections
 * Code blocks are detected by fenced code block syntax (```language ... ```)
 */
function splitContentSections(content: string): ContentSection[] {
  const sections: ContentSection[] = [];

  // First, extract code blocks using regex
  // Matches ```language\ncode\n``` or ```\ncode\n```
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    // Add any content before this code block
    if (match.index > lastIndex) {
      const beforeContent = content.slice(lastIndex, match.index);
      const beforeSections = splitTextAndTableSections(beforeContent);
      sections.push(...beforeSections);
    }

    // Add the code block
    sections.push({
      type: 'code',
      language: match[1] || 'text',
      content: match[2],
    });

    lastIndex = match.index + match[0].length;
  }

  // Add any remaining content after the last code block
  if (lastIndex < content.length) {
    const afterContent = content.slice(lastIndex);
    const afterSections = splitTextAndTableSections(afterContent);
    sections.push(...afterSections);
  }

  // If no code blocks were found, just split text/tables
  if (sections.length === 0) {
    return splitTextAndTableSections(content);
  }

  return sections;
}

/**
 * Split content into text and table sections (helper for non-code content)
 */
function splitTextAndTableSections(content: string): ContentSection[] {
  const lines = content.split('\n');
  const sections: ContentSection[] = [];
  let currentSection: ContentSection | null = null;

  for (const line of lines) {
    const lineIsTable = isTableLine(line) || isTableSeparator(line);
    const sectionType = lineIsTable ? 'table' : 'text';

    if (!currentSection || currentSection.type !== sectionType) {
      if (currentSection) {
        sections.push(currentSection);
      }
      currentSection = { type: sectionType, content: line };
    } else {
      currentSection.content += '\n' + line;
    }
  }

  if (currentSection) {
    sections.push(currentSection);
  }

  return sections;
}

export interface FormatMessageOptions {
  mentions?: string[];
}

/**
 * Format message body with newline preservation, link detection, table, and code support
 */
export function formatMessageBody(content: string, options: FormatMessageOptions = {}): React.ReactNode {
  const normalizedContent = content
    .replace(/\\n/g, '\n')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  const sections = splitContentSections(normalizedContent);

  // If only one section and not a table, use simple rendering
  if (sections.length === 1 && sections[0].type === 'text') {
    const lines = normalizedContent.split('\n');
    return lines.map((line, i) => (
      <React.Fragment key={i}>
        {i > 0 && <br />}
        {formatLine(line, options.mentions)}
      </React.Fragment>
    ));
  }

  // Render mixed content with tables and code blocks
  return sections.map((section, sectionIndex) => {
    if (section.type === 'code') {
      return (
        <CodeBlock
          key={sectionIndex}
          code={section.content}
          language={section.language || 'text'}
        />
      );
    }

    if (section.type === 'table') {
      return (
        <pre
          key={sectionIndex}
          className="font-mono text-xs leading-relaxed whitespace-pre overflow-x-auto my-2 p-3 bg-bg-tertiary/50 rounded-lg border border-border-subtle"
        >
          {section.content}
        </pre>
      );
    }

    // Regular text section
    const lines = section.content.split('\n');
    return (
      <span key={sectionIndex}>
        {lines.map((line, i) => (
          <React.Fragment key={i}>
            {i > 0 && <br />}
            {formatLine(line, options.mentions)}
          </React.Fragment>
        ))}
      </span>
    );
  });
}

/**
 * Format a single line, detecting URLs, inline code, and mentions
 */
function formatLine(line: string, mentions?: string[]): React.ReactNode {
  // Combined regex to match URLs and inline code (backticks)
  // Order matters: check for backticks first to avoid URL detection inside code
  const combinedRegex = /(`[^`]+`|https?:\/\/[^\s]+)/g;
  const parts = line.split(combinedRegex);

  return parts.map((part, i) => {
    if (!part) return null;

    // Check for inline code (backticks)
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      const code = part.slice(1, -1);
      return (
        <code
          key={`code-${i}`}
          className="px-1.5 py-0.5 mx-0.5 rounded bg-bg-elevated/80 text-accent-cyan font-mono text-[0.85em] border border-border-subtle/50"
        >
          {code}
        </code>
      );
    }

    // Check for URLs
    if (/^https?:\/\//.test(part)) {
      return (
        <a
          key={`url-${i}`}
          href={part}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent-cyan no-underline hover:underline"
        >
          {part}
        </a>
      );
    }

    return highlightMentions(part, mentions, `text-${i}`);
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightMentions(text: string, mentions: string[] | undefined, keyPrefix: string): React.ReactNode {
  if (!mentions || mentions.length === 0) {
    return text;
  }

  const escapedMentions = mentions.map(escapeRegExp).filter(Boolean);
  if (escapedMentions.length === 0) {
    return text;
  }

  const pattern = new RegExp(`@(${escapedMentions.join('|')})\\b`, 'g');
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    nodes.push(
      <span
        key={`${keyPrefix}-mention-${match.index}`}
        className="px-1 py-0.5 bg-accent-cyan/20 text-accent-cyan rounded"
      >
        @{match[1]}
      </span>
    );

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes.length > 0 ? nodes : text;
}
