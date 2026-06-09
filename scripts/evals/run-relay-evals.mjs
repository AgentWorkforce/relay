#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  assertHumanEvalExpected,
  createDefaultHumanEvalExecutors,
  createHumanEvalRunRecord,
  defaultRedactActual,
  humanEvalNeedsReview,
  loadDotenv,
  loadHumanEvalCasesFromSuitesDir,
  matchesHumanEvalFilters,
  printHumanEvalRunSummary,
  validateHumanEvalCase,
  writeHumanEvalRunArtifacts,
} from "@agent-assistant/telemetry/evals";

import { assertRelayExpected } from "./relay-checks.mjs";
import { createRelayExecutor } from "./relay-executor.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SUITES_DIR = path.join(ROOT, "evals", "suites");
const RUNS_DIR = path.join(ROOT, ".relay", "evals", "runs");

loadDotenv(path.join(ROOT, ".env"));

const args = parseArgs(process.argv.slice(2));
const mode = args.mode ?? "offline";
const allCases = loadHumanEvalCasesFromSuitesDir(SUITES_DIR, { rootDir: ROOT });
const selectedCases = allCases.filter((testCase) => matchesHumanEvalFilters(testCase, {
  suite: args.suite,
  caseId: args.caseId,
  tags: args.tags,
}));

if (args.list) {
  listCases(selectedCases);
  process.exit(0);
}

if (selectedCases.length === 0) {
  console.log("No eval cases selected.");
  console.log("Add human-authored markdown cases under evals/suites/*/cases.md and run npm run evals:compile.");
  console.log("Try: npm run evals:list");
  process.exit(0);
}

const run = createRunRecord({ selectedCases, mode });
const executors = {
  ...createDefaultHumanEvalExecutors(ROOT),
  relay: createRelayExecutor(),
};

for (const testCase of selectedCases) {
  const trials = readPositiveInt(args.trials ?? testCase.trials, 1);
  for (let trialIndex = 0; trialIndex < trials; trialIndex += 1) {
    const startedAt = Date.now();
    const executorName = args.executor ?? testCase.executor ?? "relay";
    const trial = {
      id: testCase.id,
      suite: testCase.suite,
      kind: testCase.kind ?? "capability",
      executor: executorName,
      trial: trialIndex + 1,
      tags: testCase.tags ?? [],
      status: "failed",
      duration_ms: 0,
      checks: [],
      input: testCase.input,
      expected: testCase.expected,
    };

    try {
      validateHumanEvalCase(testCase);
      const executor = executors[executorName];
      if (executor === undefined) throw new Error(`Unknown executor "${executorName}" for ${testCase.id}`);

      const actual = await executor(testCase, { providerMode: false, rootDir: ROOT });
      const checks = [...assertHumanEvalExpected(testCase, actual), ...assertRelayExpected(testCase, actual)];
      const deterministicPassed = checks.every((check) => check.passed);
      const needsHuman = deterministicPassed && humanEvalNeedsReview(testCase);

      run.tests.push({
        ...trial,
        status: deterministicPassed ? (needsHuman ? "needs-human" : "passed") : "failed",
        actual: redactRelayActual(actual),
        checks,
        duration_ms: Date.now() - startedAt,
      });
    } catch (error) {
      run.tests.push({
        ...trial,
        status: isSkippedError(error) ? "skipped" : "failed",
        error: error instanceof Error ? error.message : String(error),
        duration_ms: Date.now() - startedAt,
      });
    } finally {
      writeHumanEvalRunArtifacts(run);
    }
  }
}

writeHumanEvalRunArtifacts(run, { final: true });
printHumanEvalRunSummary(run, { productName: "Relay Evals", rootDir: ROOT });
process.exitCode = run.tests.some((test) => test.status === "failed" || (shouldFailOnSkipped(args) && test.status === "skipped")) ? 1 : 0;

function parseArgs(argv) {
  const parsed = { tags: new Set() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--list") parsed.list = true;
    else if (arg === "--suite") parsed.suite = readOptionValue(argv, ++index, "--suite");
    else if (arg === "--case") parsed.caseId = readOptionValue(argv, ++index, "--case");
    else if (arg === "--executor") parsed.executor = readOptionValue(argv, ++index, "--executor");
    else if (arg === "--tag" || arg === "--tags") {
      for (const tag of readOptionValue(argv, ++index, arg).split(",")) {
        if (tag.trim()) parsed.tags.add(tag.trim());
      }
    } else if (arg === "--trials") parsed.trials = Number(readOptionValue(argv, ++index, "--trials"));
    else if (arg === "--mode") parsed.mode = readOptionValue(argv, ++index, "--mode");
    else if (arg === "--fail-on-skipped") parsed.failOnSkipped = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function readOptionValue(argv, index, option) {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function printHelp() {
  console.log(`Usage: node scripts/evals/run-relay-evals.mjs [options]

Options:
  --list             List selected cases without running them.
  --suite NAME       Run one suite.
  --case ID          Run one case id.
  --tag TAGS         Require tag(s), comma-separated. Can be repeated.
  --trials N         Override trial count for every case.
  --executor NAME    Override selected cases to run with this executor.
  --mode MODE        Run mode label, usually offline.
  --fail-on-skipped  Treat skipped cases as a non-zero exit condition.
`);
}

function listCases(cases) {
  if (cases.length === 0) {
    console.log("No eval cases found.");
    return;
  }
  for (const testCase of cases) {
    const tags = Array.isArray(testCase.tags) && testCase.tags.length > 0 ? ` [${testCase.tags.join(",")}]` : "";
    console.log(`${testCase.id} (${testCase.suite}/${testCase.executor ?? "relay"})${tags}`);
  }
}

function createRunRecord({ selectedCases, mode }) {
  const timestampForName = new Date().toISOString().replace(/[:.]/g, "-");
  const git = getGitInfo(ROOT);
  const runName = `${timestampForName}-${sanitize(git.branch)}-${sanitize(mode)}`;
  return createHumanEvalRunRecord({
    timestamp: new Date().toISOString(),
    branch: git.branch,
    gitSha: git.sha,
    mode,
    selectedCaseCount: selectedCases.length,
    runDir: path.join(RUNS_DIR, runName),
  });
}

function getGitInfo(rootDir) {
  const branch = runGitInfoCommand(rootDir, ["rev-parse", "--abbrev-ref", "HEAD"], "branch");
  const sha = runGitInfoCommand(rootDir, ["rev-parse", "--short", "HEAD"], "sha");
  return { branch, sha };
}

function runGitInfoCommand(rootDir, gitArgs, label) {
  const result = spawnSync("git", gitArgs, { cwd: rootDir, encoding: "utf8" });
  const value = result.stdout?.trim();
  if (result.status !== 0 || !value) {
    const detail = result.error?.message || result.stderr?.trim() || `status=${result.status ?? "unknown"}`;
    console.warn(`getGitInfo: failed to read ${label} with git ${gitArgs.join(" ")}: ${detail}`);
    return "unknown";
  }
  return value;
}

function shouldFailOnSkipped(args) {
  return args.failOnSkipped || process.env.RELAY_EVAL_FAIL_ON_SKIPPED === "1" || process.env.HUMAN_EVAL_FAIL_ON_SKIPPED === "1";
}

function readPositiveInt(raw, fallback) {
  const value = Number(raw ?? fallback);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function sanitize(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 80);
}

function redactRelayActual(actual) {
  const redacted = defaultRedactActual(actual);
  if (!actual || typeof actual !== "object") return redacted;
  return {
    ...redacted,
    observed: actual.observed,
    messages: actual.messages,
    channels: actual.channels,
    agents: actual.agents,
    inboxItems: actual.inboxItems,
    workspace: actual.workspace,
  };
}

function isSkippedError(error) {
  return Boolean(error && typeof error === "object" && "code" in error && (
    error.code === "HUMAN_EVAL_SKIPPED" || error.code === "SAGE_EVAL_SKIPPED"
  ));
}
