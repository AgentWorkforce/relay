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

from typing import Final


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
      const defaultNote = modelConfig.default ? ' (default)' : '';
      output += `    ${toSnakeCase(model)}: Final[str] = "${modelConfig.id}"  # ${modelConfig.description}${defaultNote}\n`;
    }
    output += `

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

// Generate swarm patterns
output += `class SwarmPatterns:
    """Swarm patterns for multi-agent workflows."""
`;
for (const [pattern, config] of Object.entries(registry.swarm_patterns)) {
  output += `    ${toSnakeCase(pattern)}: Final[str] = "${config.id}"  # ${config.description}\n`;
}
output += `

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

// Also create __init__.py if it doesn't exist
const initPath = join(outputDir, '__init__.py');
if (!existsSync(initPath)) {
  writeFileSync(initPath, `"""Agent Relay Python SDK."""

from .models import (
    CLIs,
    CLIVersions,
    CLIRegistry,
    Models,
    SwarmPatterns,
)

__all__ = [
    "CLIs",
    "CLIVersions",
    "CLIRegistry",
    "Models",
    "SwarmPatterns",
]
`);
  console.log(`Generated ${initPath}`);
}
