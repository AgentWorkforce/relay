import React from 'react';
import { describe, expect, it } from 'vitest';

import { HighlightedPre } from '../../web/components/docs/HighlightedCode';
import { encodeCodeFenceMeta } from '../../web/lib/code-fence-meta';

function findElementByType(node: React.ReactNode, type: string): React.ReactElement | null {
  if (!React.isValidElement(node)) {
    return null;
  }

  if (node.type === type) {
    return node;
  }

  for (const child of React.Children.toArray(node.props.children)) {
    const found = findElementByType(child, type);
    if (found) {
      return found;
    }
  }

  return null;
}

describe('HighlightedPre', () => {
  it('preserves the encoded metadata token while adding a normalized language class', async () => {
    const token = encodeCodeFenceMeta({
      language: 'npm',
      label: 'npm',
      filename: 'package.json',
    });

    const element = await HighlightedPre({
      children: (
        <code className={`language-${token} custom-code-class`}>
          {'npm install agent-relay'}
        </code>
      ),
    });
    const codeElement = findElementByType(element, 'code');

    expect(codeElement?.props.className).toBe(`language-${token} custom-code-class language-npm`);
    expect(codeElement?.props['data-language']).toBe('npm');
  });
});
