#!/usr/bin/env node
/**
 * Generate Python models from cli-registry.yaml
 *
 * Usage: node codegen-py.mjs
 * Output: ../sdk-py/agent_relay/models.py
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { parse } from 'yaml';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const registryPath = join(__dirname, 'cli-registry.yaml');
const outputDir = join(__dirname, '../sdk-py/agent_relay');
const outputPath = join(outputDir, 'models.py');

// Create output directory if it doesn't exist
if (!existsSync(outputDir)) {
  mkdirSync(outputDir, { recursive: true });
}

const registry = parse(readFileSync(registryPath, 'utf8'));

function toPascalCase(str) {
  return str.replace(/(^|[-_])(\w)/g, (_, __, c) => c.toUpperCase());
}

function toSnakeCase(str) {
  return str.replace(/-/g, '_').toUpperCase();
}

let output = `"""
AUTO-GENERATED FILE - DO NOT EDIT
Generated from packages/shared/cli-registry.yaml
Run: npm run codegen:models
"""

from typing import Final, TypedDict, List


`;

// Generate CLI versions
output += `class CLIVersions:
    """CLI tool versions. Update packages/shared/cli-registry.yaml to change versions."""
`;
for (const [cli, config] of Object.entries(registry.clis)) {
  output += `    ${toSnakeCase(cli)}: Final[str] = "${config.version}"  # ${config.name}\n`;
}
output += `

`;

// Generate CLI names
output += `class CLIs:
    """Supported CLI tools."""
`;
for (const [cli] of Object.entries(registry.clis)) {
  output += `    ${toSnakeCase(cli)}: Final[str] = "${cli}"\n`;
}
output += `

`;

// Generate models per CLI
for (const [cli, config] of Object.entries(registry.clis)) {
  const pascalCli = toPascalCase(cli);
  const models = config.models || {};

  if (Object.keys(models).length > 0) {
    output += `class ${pascalCli}Models:
    """${config.name} model identifiers."""
`;
    for (const [model, modelConfig] of Object.entries(models)) {
      const label = modelConfig.label || modelConfig.id;
      const defaultNote = modelConfig.default ? ' (default)' : '';
      output += `    ${toSnakeCase(model)}: Final[str] = "${modelConfig.id}"  # ${label}${defaultNote}\n`;
    }
    output += `

`;
  }
}

// Generate ModelOption TypedDict
output += `class ModelOption(TypedDict):
    """Model option for UI dropdowns."""
    value: str
    label: str


`;

// Generate model options per CLI
for (const [cli, config] of Object.entries(registry.clis)) {
  const snakeCli = toSnakeCase(cli);
  const models = config.models || {};

  if (Object.keys(models).length > 0) {
    output += `${snakeCli}_MODEL_OPTIONS: Final[List[ModelOption]] = [
`;
    for (const [, modelConfig] of Object.entries(models)) {
      const label = modelConfig.label || modelConfig.id;
      output += `    {"value": "${modelConfig.id}", "label": "${label}"},\n`;
    }
    output += `]

`;
  }
}

// Generate combined Models class
output += `class Models:
    """All models grouped by CLI tool."""
`;
for (const [cli, config] of Object.entries(registry.clis)) {
  const pascalCli = toPascalCase(cli);
  const models = config.models || {};
  if (Object.keys(models).length > 0) {
    output += `    ${pascalCli} = ${pascalCli}Models\n`;
  }
}
output += `

`;

// Generate combined ModelOptions class
output += `class ModelOptions:
    """All model options grouped by CLI tool (for UI dropdowns)."""
`;
for (const [cli, config] of Object.entries(registry.clis)) {
  const pascalCli = toPascalCase(cli);
  const snakeCli = toSnakeCase(cli);
  const models = config.models || {};
  if (Object.keys(models).length > 0) {
    output += `    ${pascalCli} = ${snakeCli}_MODEL_OPTIONS\n`;
  }
}
output += `

`;

// Generate swarm patterns
output += `class SwarmPatterns:
    """Swarm patterns for multi-agent workflows."""
`;
for (const [pattern, config] of Object.entries(registry.swarm_patterns)) {
  output += `    ${toSnakeCase(pattern)}: Final[str] = "${config.id}"  # ${config.description}\n`;
}
output += `

`;

// Generate default models
output += `DEFAULT_MODELS: Final[dict] = {
`;
for (const [cli, config] of Object.entries(registry.clis)) {
  const models = config.models || {};
  const defaultModel = Object.values(models).find((m) => m.default);
  if (defaultModel) {
    output += `    "${cli}": "${defaultModel.id}",\n`;
  }
}
output += `}

`;

// Generate CLI registry dict
output += `CLI_REGISTRY: Final[dict] = {
`;
for (const [cli, config] of Object.entries(registry.clis)) {
  output += `    "${cli}": {
        "name": "${config.name}",
        "package": "${config.package}",
        "version": "${config.version}",
        "install": "${config.install}",
    },
`;
}
output += `}
`;

writeFileSync(outputPath, output);
console.log(`Generated ${outputPath}`);

// Update __init__.py with new exports
const initPath = join(outputDir, '__init__.py');
writeFileSync(
  initPath,
  `"""Agent Relay Python SDK."""

from .models import (
    CLIs,
    CLIVersions,
    CLI_REGISTRY,
    DEFAULT_MODELS,
    Models,
    ModelOptions,
    SwarmPatterns,
)

__all__ = [
    "CLIs",
    "CLIVersions",
    "CLI_REGISTRY",
    "DEFAULT_MODELS",
    "Models",
    "ModelOptions",
    "SwarmPatterns",
]
`
);
console.log(`Generated ${initPath}`);
