import { describe, expect, it } from 'vitest';

import { parseStrictWorkflowYaml } from '../relayflows/cases/1682-trusted-cleanroom-runner/strict-yaml-subset.mjs';

describe('hermetic RelayFlow workflow YAML parser', () => {
  it('parses mappings, sequences, flow needs, literal commands, and pinned-action comments', () => {
    const workflow = parseStrictWorkflowYaml(`
name: Trusted runner
on:
  workflow_run:
    workflows:
      - Request producer
    types:
      - completed
permissions: {}
jobs:
  qualification:
    needs: [verify-request, artifact-gate]
    steps:
      - name: Trusted checkout
        uses: actions/checkout@012345 # pinned digest
      - name: Run verifier
        run: |
          echo "actions/checkout@attacker is only command text"
          node verifier.mjs
`);

    expect(workflow.on.workflow_run).toEqual({
      workflows: ['Request producer'],
      types: ['completed'],
    });
    expect(workflow.permissions).toEqual({});
    expect(workflow.jobs.qualification.needs).toEqual(['verify-request', 'artifact-gate']);
    expect(workflow.jobs.qualification.steps).toEqual([
      { name: 'Trusted checkout', uses: 'actions/checkout@012345' },
      {
        name: 'Run verifier',
        run: 'echo "actions/checkout@attacker is only command text"\nnode verifier.mjs\n',
      },
    ]);
  });

  it('does not promote commented or quoted lookalikes into workflow structure', () => {
    const workflow = parseStrictWorkflowYaml(`
name: "uses: actions/checkout@attacker"
# jobs:
#   attacker:
permissions: {}
jobs:
  verifier:
    steps:
      - name: "permissions: write-all"
        run: echo '# uses: actions/checkout@attacker'
`);

    expect(Object.keys(workflow.jobs)).toEqual(['verifier']);
    expect(workflow.jobs.verifier.steps).toEqual([
      { name: 'permissions: write-all', run: "echo '# uses: actions/checkout@attacker'" },
    ]);
  });

  it('fails closed on duplicate keys and unsupported flow mappings', () => {
    expect(() => parseStrictWorkflowYaml('permissions: {}\npermissions: write-all\n')).toThrow(
      /duplicate mapping key/
    );
    expect(() => parseStrictWorkflowYaml('permissions: { contents: write }\n')).toThrow(
      /flow mappings are not supported/
    );
  });
});
