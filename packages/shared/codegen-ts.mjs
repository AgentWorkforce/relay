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
const outputPath = join(__dirname, '../config/src/cli-registry.generated.ts');

const registry = parse(readFileSync(registryPath, 'utf8'));

function toPascalCase(str) {
  return str.replace(/(^|[-_])(\w)/g, (_, __, c) => c.toUpperCase());
}

function toConstantCase(str) {
  return str.toUpperCase().replace(/-/g, '_');
}

let output = `/**
 * CLI Registry - AUTO-GENERATED FILE - DO NOT EDIT
 * Generated from packages/shared/cli-registry.yaml
 * Run: npm run codegen:models
 *
 * This is the single source of truth for CLI tools, versions, and models.
 * Other packages should import from @agent-relay/config.
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

// Generate models per CLI (constants)
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
      const description = modelConfig.label || modelConfig.description || modelConfig.id;
      output += `  /** ${description}${modelConfig.default ? ' (default)' : ''} */\n`;
      output += `  ${toConstantCase(model)}: '${modelConfig.id}',\n`;
    }
    output += `} as const;

export type ${pascalCli}Model = (typeof ${pascalCli}Models)[keyof typeof ${pascalCli}Models];

`;
  }
}

// Generate model options per CLI (for dashboard dropdowns)
output += `/** Model option type for UI dropdowns */
export interface ModelOption {
  value: string;
  label: string;
}

`;

for (const [cli, config] of Object.entries(registry.clis)) {
  const constantCli = toConstantCase(cli);
  const models = config.models || {};

  if (Object.keys(models).length > 0) {
    output += `/**
 * ${config.name} model options for UI dropdowns.
 */
export const ${constantCli}_MODEL_OPTIONS: ModelOption[] = [
`;
    for (const [, modelConfig] of Object.entries(models)) {
      const label = modelConfig.label || modelConfig.id;
      output += `  { value: '${modelConfig.id}', label: '${label}' },\n`;
    }
    output += `];

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
 * await relay.codex.spawn({ model: Models.Codex.GPT_5_2_CODEX });
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

// Generate combined ModelOptions object
output += `/**
 * All model options grouped by CLI tool (for UI dropdowns).
 *
 * @example
 * \`\`\`typescript
 * import { ModelOptions } from '@agent-relay/sdk';
 *
 * <select>
 *   {ModelOptions.Claude.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
 * </select>
 * \`\`\`
 */
export const ModelOptions = {
`;
for (const [cli, config] of Object.entries(registry.clis)) {
  const pascalCli = toPascalCase(cli);
  const constantCli = toConstantCase(cli);
  const models = config.models || {};
  if (Object.keys(models).length > 0) {
    output += `  ${pascalCli}: ${constantCli}_MODEL_OPTIONS,\n`;
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

// Note: SwarmPattern type is defined in workflows/types.ts to avoid duplication

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
    npmLink: ${config.npm_link ? `'${config.npm_link}'` : 'undefined'},
  },
`;
}
output += `} as const;

`;

// Generate default model per CLI
output += `/**
 * Default model for each CLI tool.
 */
export const DefaultModels = {
`;
for (const [cli, config] of Object.entries(registry.clis)) {
  const models = config.models || {};
  const defaultModel = Object.values(models).find((m) => m.default);
  if (defaultModel) {
    output += `  ${cli}: '${defaultModel.id}',\n`;
  }
}
output += `} as const;
`;

writeFileSync(outputPath, output);
console.log(`Generated ${outputPath}`);
