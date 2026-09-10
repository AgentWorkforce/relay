import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = path.resolve(import.meta.dirname, '../..');
const WORKFLOW_DIRECTORY = path.join(ROOT, '.github', 'workflows');

type Workflow = {
  name?: unknown;
  on?: unknown;
  permissions?: unknown;
  jobs?: unknown;
};

async function workflow(name: string): Promise<{ source: string; value: Workflow }> {
  const source = await readFile(path.join(WORKFLOW_DIRECTORY, name), 'utf8');
  return { source, value: parse(source) as Workflow };
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  expect(value, label).toBeTypeOf('object');
  expect(value, label).not.toBeNull();
  expect(Array.isArray(value), label).toBe(false);
  return value as Record<string, unknown>;
}

describe('qualification workflow dispatch bootstrap', () => {
  it('keeps the package producer source-bound while refusing secrets and schedules', async () => {
    const { source, value } = await workflow('relay-package-qualification.yml');
    expect(value.name).toBe('Relay package qualification');
    expect(Object.keys(requireObject(value.on, 'package triggers'))).toEqual(['workflow_dispatch']);
    expect(value.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(requireObject(value.jobs, 'package jobs'))).toEqual(['attest']);
    expect(source).toContain('actions/checkout@');
    expect(source).toContain('actions/upload-artifact@');
    expect(source).toContain('artifact-digest');
    expect(source).not.toContain('secrets.');
    expect(source).not.toContain('schedule:');
    expect(source).not.toContain('release:');
    expect(source).not.toContain('repository_dispatch:');
    expect(source).not.toContain('environment: snapshot-qualification');
  });

  it('keeps the cleanroom workflow as a no-secret manual bootstrap', async () => {
    const file = 'relay-cleanroom-qualification.yml';
    const { source, value } = await workflow(file);
    expect(value.name).toBe('Relay orchestration cleanroom qualification');
    expect(Object.keys(requireObject(value.on, `${file} triggers`))).toEqual(['workflow_dispatch']);
    expect(value.permissions).toEqual({});

    const jobs = requireObject(value.jobs, `${file} jobs`);
    expect(Object.keys(jobs)).toEqual(['dispatch-bootstrap-only']);
    const job = requireObject(jobs['dispatch-bootstrap-only'], `${file} bootstrap job`);
    expect(job).toEqual({
      'runs-on': 'ubuntu-24.04',
      'timeout-minutes': 1,
      steps: [
        {
          name: 'Refuse to claim cleanroom qualification from the bootstrap',
          run: 'echo "::error title=Dispatch bootstrap only::Select a qualification/<nonce> ref containing the complete cleanroom verifier."\nexit 1\n',
        },
      ],
    });

    expect(source).not.toContain('secrets.');
    expect(source).not.toContain('actions/checkout');
    expect(source).not.toContain('actions/upload-artifact');
    expect(source).not.toContain('schedule:');
    expect(source).not.toContain('release:');
    expect(source).not.toContain('repository_dispatch:');
    expect(source).not.toContain('environment: snapshot-qualification');
  });

  it('keeps the cleanroom dispatch inputs compatible with the candidate workflow', async () => {
    const { value } = await workflow('relay-cleanroom-qualification.yml');
    const triggers = requireObject(value.on, 'cleanroom triggers');
    const dispatch = requireObject(triggers.workflow_dispatch, 'workflow_dispatch');
    const inputs = requireObject(dispatch.inputs, 'workflow_dispatch inputs');

    expect(inputs).toEqual({
      mode: {
        description: 'Run the read-only diagnosis or an immutable candidate qualification',
        type: 'choice',
        required: true,
        default: 'diagnosis',
        options: ['diagnosis', 'qualification'],
      },
      relayfile_candidate_ref: {
        description: 'Immutable Relayfile candidate SHA for diagnosis (defaults to main)',
        type: 'string',
        required: false,
      },
      qualification_manifest_json: {
        description: 'Manual qualification manifest JSON; releases use relay-qualification.json',
        type: 'string',
        required: false,
      },
    });
  });

  it('cannot upload or attest qualification evidence from the cleanroom bootstrap', async () => {
    const { source } = await workflow('relay-cleanroom-qualification.yml');
    for (const forbidden of [
      'artifact-digest',
      'qualification.seal.json',
      'relay-package-qualification-attestation.json',
      'runtime-effects.json',
      'verify-full-relay-fleet',
    ]) {
      expect(source, `relay-cleanroom-qualification.yml must not produce ${forbidden}`).not.toContain(
        forbidden
      );
    }
  });
});
