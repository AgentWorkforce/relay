import { describe, expect, it } from 'vitest';

import {
  encodeCodeFenceMeta,
  extractCodeFenceToken,
  parseCodeFenceMetaToken,
} from '../../web/lib/code-fence-meta';

describe('code fence meta encoding', () => {
  it('round-trips filenames and labels that contain double underscores', () => {
    const token = encodeCodeFenceMeta({
      language: 'typescript',
      label: 'Type__Script',
      filename: 'src/foo__bar.ts',
    });

    expect(parseCodeFenceMetaToken(token)).toEqual({
      language: 'typescript',
      label: 'Type__Script',
      filename: 'src/foo__bar.ts',
    });
  });

  it('remains compatible with the legacy double-underscore format', () => {
    expect(
      parseCodeFenceMetaToken(
        'ar-meta__lang=typescript__label=TypeScript__file=src%2Fagent.ts'
      )
    ).toEqual({
      language: 'typescript',
      label: 'TypeScript',
      filename: 'src/agent.ts',
    });
  });

  it('prefers the metadata token when multiple language classes are present', () => {
    const token = encodeCodeFenceMeta({
      language: 'npm',
      label: 'npm',
      filename: 'package.json',
    });

    expect(
      extractCodeFenceToken(`language-bash language-${token} prose`)
    ).toBe(token);
  });
});
