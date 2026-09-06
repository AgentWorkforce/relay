import { readFileSync } from 'node:fs';

import { QUALIFICATION_PARAMS_SCHEMA } from './preflight.mjs';

const REQUIRED_FIELDS = [
  'rawEvidence',
  'candidateArtifact',
  'candidateManifest',
  'expectedHead',
  'verdictPath',
];

function argument(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

/**
 * Read the params file that carries operator-supplied paths to the verifier
 * steps. These values never travel through a shell command, so they are read
 * back here as plain JSON strings.
 */
export function readQualificationParams(argv = process.argv) {
  const paramsPath = argument(argv, '--params');
  if (!paramsPath) return undefined;
  const params = JSON.parse(readFileSync(paramsPath, 'utf8'));
  if (params?.schemaVersion !== QUALIFICATION_PARAMS_SCHEMA) {
    throw new Error(`NOT_PASS: params file schemaVersion must be ${QUALIFICATION_PARAMS_SCHEMA}`);
  }
  for (const field of REQUIRED_FIELDS) {
    if (typeof params[field] !== 'string' || !params[field]) {
      throw new Error(`NOT_PASS: params.${field} is required`);
    }
  }
  return params;
}

export { argument };
