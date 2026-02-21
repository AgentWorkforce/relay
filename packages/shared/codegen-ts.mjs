#!/usr/bin/env node
/**
 * Generate TypeScript models from cli-registry.yaml
 *
 * Usage: node codegen-ts.mjs
 * Output: ../sdk/src/models.generated.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const registryPath = join(__dirname, 'cli-registry.yaml');
const outputPath = join(__dirname, '../sdk/src/models.generated.ts');

const registry = parse(readFileSync(registryPath, 'utf8'));

function toPascalCase(str) {
  return str.replace(/(^|[-_])(\w)/g, (_, __, c) => c.toUpperCase());
}

function toConstantCase(str) {
  return str.toUpperCase().replace(/-/g, '_');
}

let output = `/**
 * AUTO-GENERATED FILE - DO NOT EDIT
 * Generated from packages/shared/cli-registry.yaml
 * Run: npm run codegen:models
 */

`;

// Generate CLI versions
output += `/**
 * CLI tool versions.
 * Update packages/shared/cli-registry.yaml to change versions.
 */
export const CLIVersions = {
`;
for (const [cli, config] of Object.entries(registry.clis)) {
  output += `  /** ${config.name} v${config.version} */\n`;
  output += `  ${toConstantCase(cli)}: '${config.version}',\n`;
}
output += `} as const;

`;

// Generate CLI names
output += `/**
 * Supported CLI tools.
 */
export const CLIs = {
`;
for (const [cli, config] of Object.entries(registry.clis)) {
  output += `  ${toConstantCase(cli)}: '${cli}',\n`;
}
output += `} as const;

export type CLI = (typeof CLIs)[keyof typeof CLIs];

`;

// Generate models per CLI
for (const [cli, config] of Object.entries(registry.clis)) {
  const pascalCli = toPascalCase(cli);
  const models = config.models || {};

  if (Object.keys(models).length > 0) {
    output += `/**
 * ${config.name} model identifiers.
 */
export const ${pascalCli}Models = {
`;
    for (const [model, modelConfig] of Object.entries(models)) {
      output += `  /** ${modelConfig.description}${modelConfig.default ? ' (default)' : ''} */\n`;
      output += `  ${toConstantCase(model)}: '${modelConfig.id}',\n`;
    }
    output += `} as const;

export type ${pascalCli}Model = (typeof ${pascalCli}Models)[keyof typeof ${pascalCli}Models];

`;
  }
}

// Generate combined Models object
output += `/**
 * All models grouped by CLI tool.
 *
 * @example
 * \`\`\`typescript
 * import { Models } from '@agent-relay/sdk';
 *
 * await relay.claude.spawn({ model: Models.Claude.OPUS });
 * await relay.codex.spawn({ model: Models.Codex.CODEX_5_3 });
 * \`\`\`
 */
export const Models = {
`;
for (const [cli, config] of Object.entries(registry.clis)) {
  const pascalCli = toPascalCase(cli);
  const models = config.models || {};
  if (Object.keys(models).length > 0) {
    output += `  ${pascalCli}: ${pascalCli}Models,\n`;
  }
}
output += `} as const;

`;

// Generate swarm patterns
output += `/**
 * Swarm patterns for multi-agent workflows.
 */
export const SwarmPatterns = {
`;
for (const [pattern, config] of Object.entries(registry.swarm_patterns)) {
  output += `  /** ${config.description} */\n`;
  output += `  ${toConstantCase(pattern)}: '${config.id}',\n`;
}
output += `} as const;

`;

// Generate CLI info for relay-cloud
output += `/**
 * Full CLI registry for relay-cloud and other services.
 */
export const CLIRegistry = {
`;
for (const [cli, config] of Object.entries(registry.clis)) {
  output += `  ${cli}: {
    name: '${config.name}',
    package: '${config.package}',
    version: '${config.version}',
    install: '${config.install}',
  },
`;
}
output += `} as const;
`;

writeFileSync(outputPath, output);
console.log(`Generated ${outputPath}`);
