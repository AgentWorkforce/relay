#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const personasDir = join(root, 'personas');
const KNOWN_TIERS = ['best', 'best-value', 'minimum'];

async function loadPersonaFiles() {
  const entries = await readdir(personasDir);
  return entries.filter((name) => name.endsWith('.json')).sort();
}

function validatePersona(filename, persona) {
  const errors = [];
  const expectedId = basename(filename, '.json');

  if (typeof persona !== 'object' || persona === null || Array.isArray(persona)) {
    errors.push('persona must be a JSON object');
    return errors;
  }

  if (typeof persona.id !== 'string' || persona.id.length === 0) {
    errors.push('missing required string field: id');
  } else if (persona.id !== expectedId) {
    errors.push(`id "${persona.id}" does not match filename "${expectedId}"`);
  }

  if (typeof persona.intent !== 'string' || persona.intent.length === 0) {
    errors.push('missing required string field: intent');
  }
  if (typeof persona.description !== 'string' || persona.description.length === 0) {
    errors.push('missing required string field: description');
  }

  if (persona.tags !== undefined && !Array.isArray(persona.tags)) {
    errors.push('tags must be an array when present');
  }

  if (persona.skills !== undefined) {
    if (!Array.isArray(persona.skills)) {
      errors.push('skills must be an array when present');
    } else {
      persona.skills.forEach((skill, idx) => {
        if (typeof skill !== 'object' || skill === null) {
          errors.push(`skills[${idx}] must be an object`);
          return;
        }
        if (typeof skill.id !== 'string' || skill.id.length === 0) {
          errors.push(`skills[${idx}].id must be a non-empty string`);
        }
        if (typeof skill.source !== 'string' || skill.source.length === 0) {
          errors.push(`skills[${idx}].source must be a non-empty string`);
        }
        if (typeof skill.description !== 'string' || skill.description.length === 0) {
          errors.push(`skills[${idx}].description must be a non-empty string`);
        }
      });
    }
  }

  if (typeof persona.tiers !== 'object' || persona.tiers === null || Array.isArray(persona.tiers)) {
    errors.push('missing required object field: tiers');
    return errors;
  }

  const tierKeys = Object.keys(persona.tiers);
  const validTierKeys = tierKeys.filter((k) => KNOWN_TIERS.includes(k));
  if (validTierKeys.length === 0) {
    errors.push(`tiers must include at least one of: ${KNOWN_TIERS.join(', ')}`);
  }

  for (const [tierName, tier] of Object.entries(persona.tiers)) {
    if (!KNOWN_TIERS.includes(tierName)) {
      errors.push(`unknown tier "${tierName}" (expected one of: ${KNOWN_TIERS.join(', ')})`);
      continue;
    }
    if (typeof tier !== 'object' || tier === null) {
      errors.push(`tiers.${tierName} must be an object`);
      continue;
    }
    if (typeof tier.harness !== 'string' || tier.harness.length === 0) {
      errors.push(`tiers.${tierName}.harness must be a non-empty string`);
    }
    if (typeof tier.model !== 'string' || tier.model.length === 0) {
      errors.push(`tiers.${tierName}.model must be a non-empty string`);
    }
    if (typeof tier.systemPrompt !== 'string' || tier.systemPrompt.length === 0) {
      errors.push(`tiers.${tierName}.systemPrompt must be a non-empty string`);
    }
    if (
      tier.harnessSettings !== undefined &&
      (typeof tier.harnessSettings !== 'object' || tier.harnessSettings === null || Array.isArray(tier.harnessSettings))
    ) {
      errors.push(`tiers.${tierName}.harnessSettings must be an object when present`);
    }
  }

  return errors;
}

async function main() {
  const files = await loadPersonaFiles();
  if (files.length === 0) {
    console.error(`no persona JSON files found in ${personasDir}`);
    process.exit(1);
  }

  let failed = 0;
  const seenIds = new Map();

  for (const file of files) {
    const fullPath = join(personasDir, file);
    let persona;
    try {
      const raw = await readFile(fullPath, 'utf8');
      persona = JSON.parse(raw);
    } catch (err) {
      console.error(`✗ ${file}: failed to parse JSON — ${err?.message ?? err}`);
      failed++;
      continue;
    }

    const errors = validatePersona(file, persona);

    if (typeof persona?.id === 'string') {
      if (seenIds.has(persona.id)) {
        errors.push(`duplicate persona id "${persona.id}" (also defined in ${seenIds.get(persona.id)})`);
      } else {
        seenIds.set(persona.id, file);
      }
    }

    if (errors.length > 0) {
      console.error(`✗ ${file}`);
      for (const e of errors) console.error(`    - ${e}`);
      failed++;
    } else {
      console.log(`✓ ${file}`);
    }
  }

  console.log(`\nvalidated ${files.length} persona file(s), ${failed} failure(s)`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('validator crashed:', err);
  process.exit(1);
});
