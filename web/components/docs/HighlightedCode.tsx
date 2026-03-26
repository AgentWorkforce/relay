import React, { type ReactElement, Children, isValidElement } from 'react';

import { highlightCode } from '../../lib/syntax';
import { CopyCodeButton } from './CopyCodeButton';
import styles from './docs.module.css';

function parseInlineStyle(styleText?: string): React.CSSProperties | undefined {
  if (!styleText) {
    return undefined;
  }

  const style: Record<string, string> = {};

  for (const declaration of styleText.split(';')) {
    const separator = declaration.indexOf(':');
    if (separator === -1) {
      continue;
    }

    const property = declaration.slice(0, separator).trim();
    const value = declaration.slice(separator + 1).trim();
    if (!property || !value) {
      continue;
    }

    if (property.startsWith('--')) {
      style[property] = value;
      continue;
    }

    const camelCased = property.replace(/-([a-z])/g, (_, character: string) =>
      character.toUpperCase()
    );
    style[camelCased] = value;
  }

  return style as React.CSSProperties;
}

/**
 * Server component that wraps <pre><code>...</code></pre> with Shiki highlighting and a copy button.
 */
export async function HighlightedPre({ children, ...props }: React.DetailedHTMLProps<React.HTMLAttributes<HTMLPreElement>, HTMLPreElement>) {
  const codeChild = Children.toArray(children).find(
    (c): c is ReactElement => isValidElement(c) && c.type === 'code'
  );

  if (!codeChild) {
    return <pre {...props}>{children}</pre>;
  }

  const raw = typeof codeChild.props.children === 'string' ? codeChild.props.children : '';
  if (!raw) {
    return <pre {...props}>{children}</pre>;
  }

  const className = codeChild.props.className || '';
  const langMatch = className.match(/language-(\S+)/);

  if (!langMatch) {
    return (
      <div className={styles.codeWrapper}>
        <CopyCodeButton code={raw} />
        <pre {...props}>{children}</pre>
      </div>
    );
  }

  const lang = langMatch[1].toLowerCase();
  const highlighted = await highlightCode(raw.trimEnd(), lang);
  const shikiStyle = parseInlineStyle(highlighted.preStyle);
  const preClassName = [props.className, highlighted.preClassName].filter(Boolean).join(' ');

  return (
    <div className={styles.codeWrapper}>
      <CopyCodeButton code={raw} />
      <pre
        {...props}
        className={preClassName || undefined}
        style={{ ...shikiStyle, ...props.style }}
      >
        <code
          className={className}
          dangerouslySetInnerHTML={{ __html: highlighted.codeHtml }}
        />
      </pre>
    </div>
  );
}
