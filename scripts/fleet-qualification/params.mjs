import { readFileSync } from 'node:fs';

import { QUALIFICATION_PARAMS_SCHEMA } from './preflight.mjs';

const REQUIRED_FIELDS = [
  'rawEvidence',
  'candidateArtifact',
  'candidateManifest',
  'expectedHead',
  'verdictPath',
];

/**
 * Every flag this module and verify-evidence.mjs accept. A value that is itself
 * one of these is a malformed command line, not a value.
 */
const KNOWN_FLAGS = new Set([
  '--params',
  '--input',
  '--output',
  '--expected-head',
  '--candidate-artifact',
  '--candidate-manifest',
]);

/**
 * Read the token after `name`. Returns undefined when the flag is last on the
 * line or its "value" is another known flag, so a malformed
 * `--input --expected-head <sha>` fails the caller's required-argument check
 * instead of silently binding the SHA to `--input`.
 */
function argument(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || KNOWN_FLAGS.has(value)) return undefined;
  return value;
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
