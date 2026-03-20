'use client';

import React, { type ReactElement, Children, isValidElement } from 'react';

import { highlightCode } from '../../lib/syntax';

/**
 * Wraps a <pre><code>...</code></pre> and applies syntax highlighting.
 * Used as a custom `pre` component in MDX.
 */
export function HighlightedPre({ children, ...props }: React.DetailedHTMLProps<React.HTMLAttributes<HTMLPreElement>, HTMLPreElement>) {
  // Find the <code> child
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

  const highlighted = highlightCode(raw);

  return (
    <pre {...props}>
      <code
        className={codeChild.props.className}
        dangerouslySetInnerHTML={{ __html: highlighted }}
      />
    </pre>
  );
}
