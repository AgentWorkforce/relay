#!/usr/bin/env node
/**
 * Check for new CLI versions and optionally update cli-registry.yaml
 *
 * Usage:
 *   node scripts/check-cli-versions.mjs          # Check only, print diff
 *   node scripts/check-cli-versions.mjs --update # Update cli-registry.yaml
 *
 * Environment variables:
 *   ANTHROPIC_API_KEY - For fetching Claude models (optional)
 *   OPENAI_API_KEY    - For fetching OpenAI/Codex models (optional)
 *   GOOGLE_API_KEY    - For fetching Gemini models (optional)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { parse, stringify } from 'yaml';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const registryPath = join(__dirname, '../packages/shared/cli-registry.yaml');

const shouldUpdate = process.argv.includes('--update');

// NPM package names for each CLI
const NPM_PACKAGES = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  gemini: '@google/gemini-cli',
  aider: null, // pip package, not npm
  goose: null, // pip package, not npm
  cursor: null, // Not an npm package
};

// PyPI package names
const PYPI_PACKAGES = {
  aider: 'aider-chat',
  goose: 'goose-ai',
};

async function getLatestNpmVersion(packageName) {
  try {
    const result = execSync(`npm view ${packageName} version`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return result;
  } catch (error) {
    console.error(`  Failed to fetch npm version for ${packageName}:`, error.message);
    return null;
  }
}

async function getLatestPypiVersion(packageName) {
  try {
    const response = await fetch(`https://pypi.org/pypi/${packageName}/json`);
    if (!response.ok) return null;
    const data = await response.json();
    return data.info.version;
  } catch (error) {
    console.error(`  Failed to fetch PyPI version for ${packageName}:`, error.message);
    return null;
  }
}

async function fetchAnthropicModels() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('  ANTHROPIC_API_KEY not set, skipping model fetch');
    return null;
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.data?.map((m) => m.id) || null;
  } catch (error) {
    console.error('  Failed to fetch Anthropic models:', error.message);
    return null;
  }
}

async function fetchOpenAIModels() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.log('  OPENAI_API_KEY not set, skipping model fetch');
    return null;
  }

  try {
    const response = await fetch('https://api.openai.com/v1/models', {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.data?.map((m) => m.id) || null;
  } catch (error) {
    console.error('  Failed to fetch OpenAI models:', error.message);
    return null;
  }
}

async function fetchGoogleModels() {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.log('  GOOGLE_API_KEY not set, skipping model fetch');
    return null;
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`
    );
    if (!response.ok) return null;
    const data = await response.json();
    return data.models?.map((m) => m.name.replace('models/', '')) || null;
  } catch (error) {
    console.error('  Failed to fetch Google models:', error.message);
    return null;
  }
}

async function main() {
  console.log('Checking CLI versions...\n');

  const registry = parse(readFileSync(registryPath, 'utf8'));
  const updates = [];
  let hasChanges = false;

  // Check npm packages
  for (const [cli, npmPackage] of Object.entries(NPM_PACKAGES)) {
    if (!npmPackage) continue;

    const currentVersion = registry.clis[cli]?.version;
    console.log(`${cli}: checking ${npmPackage}...`);

    const latestVersion = await getLatestNpmVersion(npmPackage);
    if (latestVersion && latestVersion !== currentVersion) {
      console.log(`  UPDATE: ${currentVersion} → ${latestVersion}`);
      updates.push({ cli, from: currentVersion, to: latestVersion });
      if (shouldUpdate) {
        registry.clis[cli].version = latestVersion;
        hasChanges = true;
      }
    } else if (latestVersion) {
      console.log(`  OK: ${currentVersion} (latest)`);
    }
  }

  // Check PyPI packages
  for (const [cli, pypiPackage] of Object.entries(PYPI_PACKAGES)) {
    if (!pypiPackage) continue;

    const currentVersion = registry.clis[cli]?.version;
    console.log(`${cli}: checking ${pypiPackage} (PyPI)...`);

    const latestVersion = await getLatestPypiVersion(pypiPackage);
    if (latestVersion && latestVersion !== currentVersion) {
      console.log(`  UPDATE: ${currentVersion} → ${latestVersion}`);
      updates.push({ cli, from: currentVersion, to: latestVersion });
      if (shouldUpdate) {
        registry.clis[cli].version = latestVersion;
        hasChanges = true;
      }
    } else if (latestVersion) {
      console.log(`  OK: ${currentVersion} (latest)`);
    }
  }

  // Check for new models (informational only for now)
  console.log('\nChecking available models...');

  const anthropicModels = await fetchAnthropicModels();
  if (anthropicModels) {
    console.log(`  Anthropic models available: ${anthropicModels.length}`);
  }

  const openaiModels = await fetchOpenAIModels();
  if (openaiModels) {
    const codexModels = openaiModels.filter((m) => m.includes('codex') || m.includes('gpt'));
    console.log(`  OpenAI models available: ${codexModels.length} relevant`);
  }

  const googleModels = await fetchGoogleModels();
  if (googleModels) {
    const geminiModels = googleModels.filter((m) => m.includes('gemini'));
    console.log(`  Google Gemini models available: ${geminiModels.length}`);
  }

  // Summary
  console.log('\n--- Summary ---');
  if (updates.length === 0) {
    console.log('All CLI versions are up to date.');
  } else {
    console.log(`Found ${updates.length} update(s):`);
    for (const u of updates) {
      console.log(`  - ${u.cli}: ${u.from} → ${u.to}`);
    }

    if (shouldUpdate && hasChanges) {
      writeFileSync(registryPath, stringify(registry));
      console.log('\nUpdated cli-registry.yaml');
      console.log('Run `npm run codegen:models` to regenerate TypeScript/Python models.');
    } else if (!shouldUpdate) {
      console.log('\nRun with --update to apply changes.');
    }
  }

  // Exit with code 1 if updates found (useful for CI)
  process.exit(updates.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(2);
});
