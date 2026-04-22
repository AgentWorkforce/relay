/**
 * Model metadata tests.
 *
 * Run:
 *   npm run build && node --test dist/__tests__/models.test.js
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  ModelMetadata,
  ModelOptions,
  Models,
  ReasoningEfforts,
  getDefaultReasoningEffort,
  getModelMetadata,
  getSupportedReasoningEfforts,
} from '../models.js';

test('codex model options include reasoning effort metadata', () => {
  const mini = ModelOptions.Codex.find((model) => model.value === Models.Codex.GPT_5_1_CODEX_MINI);
  const frontier = ModelOptions.Codex.find((model) => model.value === Models.Codex.GPT_5_4);

  assert.deepEqual(mini?.reasoningEfforts, [ReasoningEfforts.MEDIUM, ReasoningEfforts.HIGH]);
  assert.equal(mini?.defaultReasoningEffort, ReasoningEfforts.HIGH);

  assert.deepEqual(frontier?.reasoningEfforts, [
    ReasoningEfforts.LOW,
    ReasoningEfforts.MEDIUM,
    ReasoningEfforts.HIGH,
    ReasoningEfforts.XHIGH,
  ]);
  assert.equal(frontier?.defaultReasoningEffort, ReasoningEfforts.XHIGH);
});

test('reasoning helper lookups return codex defaults and supported values', () => {
  assert.equal(getDefaultReasoningEffort('codex', Models.Codex.GPT_5_1_CODEX_MINI), ReasoningEfforts.HIGH);
  assert.equal(getDefaultReasoningEffort('codex', Models.Codex.GPT_5_4), ReasoningEfforts.XHIGH);
  assert.deepEqual(getSupportedReasoningEfforts('codex', Models.Codex.GPT_5_1_CODEX_MINI), [
    ReasoningEfforts.MEDIUM,
    ReasoningEfforts.HIGH,
  ]);
  assert.equal(getDefaultReasoningEffort('claude', Models.Claude.SONNET), undefined);
});

test('model metadata is keyed by model id for direct lookup', () => {
  assert.deepEqual(
    ModelMetadata.Codex[Models.Codex.GPT_5_1_CODEX_MINI],
    getModelMetadata('codex', Models.Codex.GPT_5_1_CODEX_MINI)
  );
  assert.equal(
    ModelMetadata.Codex[Models.Codex.GPT_5_1_CODEX_MINI].defaultReasoningEffort,
    ReasoningEfforts.HIGH
  );
});
