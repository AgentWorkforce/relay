#!/usr/bin/env npx tsx
/**
 * Bulk executor for relay refactoring workflows.
 * 
 * Usage:
 *   npx tsx workflows/refactor/run-refactor.ts              # all waves
 *   npx tsx workflows/refactor/run-refactor.ts --wave 1      # just wave 1
 *   npx tsx workflows/refactor/run-refactor.ts --dry-run     # preview only
 */

import { execSync, spawn } from 'child_process';
import { existsSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relay';
const LOG_DIR = '/tmp/relay-refactor';

interface Wave {
  name: string;
  workflows: { file: string; name: string }[];
}

const WAVES: Wave[] = [
  {
    name: 'Wave 1: Decomposition Plans',
    workflows: [
      { file: '01-runner-decomposition-plan.ts', name: 'runner-plan' },
      { file: '02-main-rs-decomposition-plan.ts', name: 'main-rs-plan' },
    ],
  },
  {
    name: 'Wave 2: Small + Medium Extractions',
    workflows: [
      { file: '03-runner-extract-verification.ts', name: 'extract-verification' },
      { file: '04-runner-extract-template-channel.ts', name: 'extract-tmpl-chan' },
      { file: '06-main-rs-extract-broker-worker.ts', name: 'extract-broker-worker' },
    ],
  },
  {
    name: 'Wave 3: Large Extraction',
    workflows: [
      { file: '05-runner-extract-step-executor.ts', name: 'extract-step-executor' },
    ],
  },
];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const waveArg = args.find(a => a.startsWith('--wave'));
const waveNum = (() => {
  if (!waveArg) return null;
  // Support --wave=N and --wave N
  const eqValue = waveArg.includes('=') ? waveArg.split('=')[1] : null;
  const nextArg = args[args.indexOf(waveArg) + 1];
  const raw = eqValue ?? (nextArg && !nextArg.startsWith('-') ? nextArg : null);
  const parsed = parseInt(raw);
  if (isNaN(parsed) || parsed < 1 || parsed > WAVES.length) {
    console.error(`Invalid --wave value: ${raw ?? '(missing)'}. Must be 1-${WAVES.length}.`);
    process.exit(1);
  }
  return parsed;
})();

if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

async function runWave(wave: Wave, index: number): Promise<boolean> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${wave.name} (${wave.workflows.length} workflows)`);
  console.log('='.repeat(60));

  if (dryRun) {
    wave.workflows.forEach(w => console.log(`  - ${w.name}: ${w.file}`));
    return true;
  }

  const promises = wave.workflows.map(wf => {
    const logFile = join(LOG_DIR, `${String(index + 1).padStart(2, '0')}-${wf.name}.log`);
    console.log(`Starting: ${wf.name} → ${logFile}`);

    return new Promise<{ name: string; success: boolean }>((resolve) => {
      const child = spawn('npx', ['tsx', join(ROOT, 'workflows/refactor', wf.file)], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      child.stdout?.on('data', (d) => appendFileSync(logFile, d));
      child.stderr?.on('data', (d) => appendFileSync(logFile, d));

      child.on('close', (code) => {
        const success = code === 0;
        console.log(`  ${success ? '✅' : '❌'} ${wf.name} (exit ${code})`);
        resolve({ name: wf.name, success });
      });
    });
  });

  const results = await Promise.all(promises);
  const allPassed = results.every(r => r.success);

  if (!allPassed) {
    console.log(`\n⚠️  Wave ${index + 1} had failures. Check logs in ${LOG_DIR}`);
  }

  return allPassed;
}

async function main() {
  console.log('Relay Refactoring Workflow Executor');
  console.log(`Repo: ${ROOT}`);
  console.log(`Mode: ${dryRun ? 'dry-run' : 'execute'}`);
  console.log(`Waves: ${waveNum ?? 'all'}`);
  console.log(`Logs: ${LOG_DIR}`);

  const wavesToRun = waveNum
    ? [WAVES[waveNum - 1]].filter(Boolean)
    : WAVES;

  for (let i = 0; i < wavesToRun.length; i++) {
    const waveIndex = waveNum ? waveNum - 1 : i;
    const passed = await runWave(wavesToRun[i], waveIndex);

    if (!passed && !dryRun) {
      console.log('\nStopping — fix failures before proceeding to next wave.');
      process.exit(1);
    }

    // Git commit between waves
    if (!dryRun && passed && i < wavesToRun.length - 1) {
      console.log('\nCommitting wave results...');
      try {
        execSync(`cd ${ROOT} && git add -A && HUSKY=0 git commit -m "refactor: wave ${waveIndex + 1} — ${wavesToRun[i].name}" --no-verify`, { stdio: 'inherit' });
      } catch {
        console.log('Nothing to commit (or commit failed)');
      }
    }
  }

  console.log('\nDone.');
}

main().catch(console.error);
