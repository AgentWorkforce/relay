import { describe, expect, it } from 'vitest';

import { defaultPermissionsForPreset, expandAccessPreset } from '../compiler.js';

describe('expandAccessPreset', () => {
  it.each([
    ['readonly', { read: ['**'], write: [], deny: [] }],
    ['restricted', { read: [], write: [], deny: [] }],
    ['full', { read: ['**'], write: ['**'], deny: [] }],
    ['readwrite', { read: ['**'], write: ['**'], deny: [] }],
  ] as const)('expands %s', (preset, expected) => {
    expect(expandAccessPreset(preset)).toEqual(expected);
  });
});

describe('defaultPermissionsForPreset', () => {
  it.each([
    ['lead', { access: 'full' }],
    ['worker', { access: 'readwrite' }],
    ['reviewer', { access: 'readonly' }],
    ['analyst', { access: 'readonly' }],
  ] as const)('maps %s to the expected default permissions', (preset, expected) => {
    expect(defaultPermissionsForPreset(preset)).toEqual(expected);
  });
});
