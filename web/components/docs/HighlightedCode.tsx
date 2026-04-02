import React, { type ReactElement, Children, isValidElement } from 'react';
import { SiPython, SiTypescript } from 'react-icons/si';

import {
  extractCodeFenceToken,
  getCodeFenceBadgeLabel,
  parseCodeFenceMetaToken,
} from '../../lib/code-fence-meta';
import { highlightCode } from '../../lib/syntax';
import { CopyCodeButton } from './CopyCodeButton';
import styles from './docs.module.css';

const codeBadgeIcons: Record<string, React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>> = {
  py: SiPython,
  python: SiPython,
  ts: SiTypescript,
  tsx: SiTypescript,
  typescript: SiTypescript,
};

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
  const token = extractCodeFenceToken(className);

  if (!token) {
    return (
      <div className={styles.codeWrapper}>
        <CopyCodeButton code={raw} />
        <pre {...props}>{children}</pre>
      </div>
    );
  }

  const meta = parseCodeFenceMetaToken(token);
  const highlighted = await highlightCode(raw.trimEnd(), meta.language.toLowerCase());
  const shikiStyle = parseInlineStyle(highlighted.preStyle);
  const preClassName = [props.className, highlighted.preClassName].filter(Boolean).join(' ');
  const wrapperClassName = meta.filename
    ? `${styles.codeWrapper} ${styles.codeWrapperWithHeader}`
    : styles.codeWrapper;
  const codeClassName = `language-${meta.language.toLowerCase()}`;
  const badgeKey = meta.filename?.split('/').pop()?.split('.').pop()?.toLowerCase() || meta.language.toLowerCase();
  const BadgeIcon = codeBadgeIcons[badgeKey];

  return (
    <div className={wrapperClassName}>
      {meta.filename ? (
        <div className={styles.codeBlockHeader}>
          <div className={styles.codeBlockHeaderMeta}>
            <span className={styles.codeBlockBadge}>
              {BadgeIcon ? (
                <BadgeIcon className={styles.codeBlockBadgeIcon} aria-hidden={true} />
              ) : (
                getCodeFenceBadgeLabel(meta.language, meta.filename)
              )}
            </span>
            <span className={styles.codeBlockFilename}>{meta.filename}</span>
          </div>
          <CopyCodeButton code={raw} inline />
        </div>
      ) : (
        <CopyCodeButton code={raw} />
      )}
      <pre
        {...props}
        className={preClassName || undefined}
        style={{ ...shikiStyle, ...props.style }}
      >
        <code
          className={codeClassName}
          dangerouslySetInnerHTML={{ __html: highlighted.codeHtml }}
        />
      </pre>
    </div>
  );
}
