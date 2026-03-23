import React, { type ReactElement, Children, isValidElement } from 'react';

import { highlightCode } from '../../lib/syntax';
import { CopyCodeButton } from './CopyCodeButton';
import styles from './docs.module.css';

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

  return (
    <div className={styles.codeWrapper}>
      <CopyCodeButton code={raw} />
      <pre {...props}>
        <code
          className={className}
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      </pre>
    </div>
  );
}
