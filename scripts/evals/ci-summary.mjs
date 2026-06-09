#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RUNS_DIR = path.join(ROOT, ".relay", "evals", "runs");

const runDir = findLatestRunDir();
if (!runDir) {
  const summary = "# Relay Eval CI Summary\n\nNo Relay eval run found.\n";
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary, { flag: "a" });
  process.exit(0);
}

const resultPath = path.join(runDir, "result.json");
const result = readResultJson(resultPath);
const failed = result.tests.filter((test) => test.status === "failed");
const skipped = result.tests.filter((test) => test.status === "skipped");
const needsHuman = result.tests.filter((test) => test.status === "needs-human");

const lines = [
  "# Relay Eval CI Summary",
  "",
  `- Run directory: \`${path.relative(ROOT, runDir)}\``,
  `- Mode: \`${result.mode}\``,
  `- Git SHA: \`${result.git_sha}\``,
  `- Passed: ${result.passed}`,
  `- Needs human review: ${result.needs_human}`,
  `- Failed: ${result.failed}`,
  `- Skipped: ${result.skipped}`,
  "",
];

appendStatusSection(lines, "Failed", failed);
appendStatusSection(lines, "Skipped", skipped);
appendNeedsHumanSection(lines, needsHuman);

const summary = `${lines.join("\n")}\n`;
console.log(summary);

if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary, { flag: "a" });
if (failed.length > 0 || skipped.length > 0) process.exitCode = 1;

function appendStatusSection(lines, title, tests) {
  if (tests.length === 0) return;
  lines.push(`## ${title}`, "");
  for (const test of tests) {
    lines.push(`- \`${test.id}\` (${test.suite}/${test.executor})`);
    if (test.error) lines.push(`  - ${test.error}`);
    for (const check of test.checks ?? []) {
      if (check.passed) continue;
      lines.push(`  - FAIL ${check.name}: ${check.message}`);
    }
  }
  lines.push("");
}

function appendNeedsHumanSection(lines, tests) {
  lines.push("## Human Review", "");
  if (tests.length === 0) {
    lines.push("No cases require human review.", "");
    return;
  }
  for (const test of tests) lines.push(`- \`${test.id}\` (${test.suite}/${test.executor})`);
  lines.push("");
}

function findLatestRunDir() {
  if (!existsSync(RUNS_DIR)) return null;
  const runs = readdirSync(RUNS_DIR)
    .map((dir) => path.join(RUNS_DIR, dir))
    .filter((dir) => existsSync(path.join(dir, "result.json")))
    .flatMap((dir) => {
      const result = safeReadResultJson(path.join(dir, "result.json"));
      return result ? [{ dir, result }] : [];
    })
    .sort((a, b) => String(b.result.timestamp).localeCompare(String(a.result.timestamp)));
  return runs[0]?.dir ?? null;
}

function readResultJson(filePath) {
  const result = safeReadResultJson(filePath);
  if (!result) throw new Error(`Could not parse Relay eval result: ${path.relative(ROOT, filePath)}`);
  return result;
}

function safeReadResultJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    console.warn(`Skipping malformed Relay eval result ${path.relative(ROOT, filePath)}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
