/**
 * CLI wrapper for MCP installation
 *
 * Provides user-friendly interface for installing MCP server
 * configuration in supported AI editors.
 */

import {
  install,
  uninstall,
  detectInstalledEditors,
  listSupportedEditors,
  isInstalledFor,
  type InstallOptions,
  type InstallResult,
} from './install.js';

export interface CliOptions {
  /** Editor to configure (auto-detect if not specified) */
  editor?: string;
  /** Install globally instead of project-local */
  global?: boolean;
  /** Show what would be done without making changes */
  dryRun?: boolean;
  /** Uninstall instead of install */
  uninstall?: boolean;
  /** List supported editors */
  list?: boolean;
  /** Show installation status */
  status?: boolean;
  /** Quiet mode - minimal output */
  quiet?: boolean;
}

/**
 * Format install result for display
 */
function formatResult(result: InstallResult, action: 'install' | 'uninstall'): string {
  const icon = result.success ? '\u2713' : '\u2717';
  const actionWord = action === 'install' ? 'configured' : 'removed';
  const createdNote = result.created ? ' (created)' : '';

  if (result.success) {
    return `  ${icon} ${result.editor} ${actionWord}${createdNote}`;
  } else {
    return `  ${icon} ${result.editor}: ${result.error}`;
  }
}

/**
 * Show installation status for all editors
 */
function showStatus(projectDir?: string): void {
  const supported = listSupportedEditors();
  const detected = detectInstalledEditors();

  console.log('MCP Installation Status');
  console.log('');
  console.log('Editor               Detected    Installed');
  console.log('-------------------------------------------');

  for (const { key, name } of supported) {
    const isDetected = detected.includes(key);
    const isInstalled = isInstalledFor(key, { projectDir });

    const detectedStr = isDetected ? '\u2713' : '-';
    const installedStr = isInstalled ? '\u2713' : '-';

    // Pad name to 20 chars
    const paddedName = name.padEnd(20);
    console.log(`${paddedName} ${detectedStr.padEnd(12)}${installedStr}`);
  }
}

/**
 * Show list of supported editors
 */
function showList(): void {
  const supported = listSupportedEditors();
  const detected = detectInstalledEditors();

  console.log('Supported Editors:');
  console.log('');

  for (const { key, name } of supported) {
    const isDetected = detected.includes(key);
    const status = isDetected ? '(detected)' : '';
    console.log(`  ${key.padEnd(15)} ${name} ${status}`);
  }

  console.log('');
  console.log('Usage:');
  console.log('  npx @agent-relay/mcp install --editor <key>');
}

/**
 * Run the install command with CLI options
 */
export function runInstall(options: CliOptions = {}): void {
  // Handle --list
  if (options.list) {
    showList();
    return;
  }

  // Handle --status
  if (options.status) {
    showStatus(process.cwd());
    return;
  }

  const installOptions: InstallOptions = {
    editor: options.editor,
    global: options.global,
    projectDir: options.global ? undefined : process.cwd(),
    dryRun: options.dryRun,
  };

  // Handle --uninstall
  if (options.uninstall) {
    if (!options.quiet) {
      console.log('Uninstalling Agent Relay MCP server...');
      if (options.dryRun) {
        console.log('(dry run - no changes will be made)');
      }
      console.log('');
    }

    const results = uninstall(installOptions);
    printResults(results, 'uninstall', options.quiet);
    return;
  }

  // Normal install
  if (!options.quiet) {
    console.log('Installing Agent Relay MCP server...');
    if (options.dryRun) {
      console.log('(dry run - no changes will be made)');
    }
    console.log('');
  }

  const results = install(installOptions);
  printResults(results, 'install', options.quiet);
}

/**
 * Print results and exit with appropriate code
 */
function printResults(
  results: InstallResult[],
  action: 'install' | 'uninstall',
  quiet?: boolean
): void {
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  if (!quiet) {
    for (const result of results) {
      console.log(formatResult(result, action));
    }
    console.log('');
  }

  // Handle no editors detected case
  if (results.length === 1 && results[0].editor === 'none') {
    console.log('No supported editors detected.');
    console.log('');
    console.log('Supported editors: claude, claude-code, cursor, vscode, windsurf, zed');
    console.log('');
    console.log('Specify manually with: npx @agent-relay/mcp install --editor <name>');
    process.exit(1);
  }

  // Summary
  if (!quiet) {
    if (failed.length === 0) {
      const actionWord = action === 'install' ? 'Installation' : 'Removal';
      console.log(`${actionWord} complete!`);

      if (action === 'install') {
        console.log('');
        console.log('The relay tools will be available when you start your editor.');
        console.log('Make sure the relay daemon is running: agent-relay up');
      }
    } else {
      console.log(`Completed with ${failed.length} error(s).`);
    }
  }

  // Exit with error if any failures
  if (failed.length > 0) {
    process.exit(1);
  }
}

/**
 * Validate editor argument
 */
export function validateEditor(editor: string): boolean {
  const supported = listSupportedEditors();
  return supported.some(e => e.key === editor);
}

/**
 * Get list of valid editor keys for CLI help
 */
export function getValidEditors(): string[] {
  return listSupportedEditors().map(e => e.key);
}
