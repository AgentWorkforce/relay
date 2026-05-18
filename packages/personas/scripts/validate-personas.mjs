#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const personasDir = join(root, 'personas');
const KNOWN_HARNESSES = ['claude', 'codex', 'opencode'];
const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

async function loadPersonaFiles() {
  const entries = await readdir(personasDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort();
}

function validatePersona(filename, persona) {
  const errors = [];
  const expectedId = basename(filename, '.json');

  if (typeof persona !== 'object' || persona === null || Array.isArray(persona)) {
    errors.push('persona must be a JSON object');
    return errors;
  }

  if (!isNonEmptyString(persona.id)) {
    errors.push('missing required string field: id');
  } else if (persona.id !== expectedId) {
    errors.push(`id "${persona.id}" does not match filename "${expectedId}"`);
  }

  if (!isNonEmptyString(persona.intent)) {
    errors.push('missing required string field: intent');
  }
  if (!isNonEmptyString(persona.description)) {
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
        if (!isNonEmptyString(skill.id)) {
          errors.push(`skills[${idx}].id must be a non-empty string`);
        }
        if (!isNonEmptyString(skill.source)) {
          errors.push(`skills[${idx}].source must be a non-empty string`);
        }
        if (!isNonEmptyString(skill.description)) {
          errors.push(`skills[${idx}].description must be a non-empty string`);
        }
      });
    }
  }

  // Workforce v3 removed the per-tier persona shape — runtime config is now
  // flat. Reject the legacy fields with a clear message.
  if ('tiers' in persona) {
    errors.push('field "tiers" is no longer supported — hoist harness/model/systemPrompt to the top level (workforce v3)');
  }
  if ('defaultTier' in persona) {
    errors.push('field "defaultTier" is no longer supported (workforce v3)');
  }

  if (!isNonEmptyString(persona.harness)) {
    errors.push('missing required string field: harness');
  } else if (!KNOWN_HARNESSES.includes(persona.harness)) {
    errors.push(`harness must be one of: ${KNOWN_HARNESSES.join(', ')} (got "${persona.harness}")`);
  }
  if (!isNonEmptyString(persona.model)) {
    errors.push('missing required string field: model');
  }
  if (!isNonEmptyString(persona.systemPrompt)) {
    errors.push('missing required string field: systemPrompt');
  }
  if (persona.harnessSettings !== undefined && !isPlainObject(persona.harnessSettings)) {
    errors.push('harnessSettings must be an object when present');
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
