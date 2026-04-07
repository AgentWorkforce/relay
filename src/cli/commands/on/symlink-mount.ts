import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import ignore, { type Ignore } from 'ignore';
import path from 'node:path';

export interface SymlinkMountOptions {
  ignoredPatterns: string[];
  readonlyPatterns: string[];
  excludeDirs: string[];
}

export interface SymlinkMountHandle {
  mountDir: string;
  syncBack(): Promise<number>;
  cleanup(): void;
}

const DEFAULT_EXCLUDED_DIRS = ['.git', 'node_modules', '.relay'];
const PERMISSIONS_AGENT_NAME = 'local-agent';

export function createSymlinkMount(
  projectDir: string,
  mountDir: string,
  options: SymlinkMountOptions
): SymlinkMountHandle {
  const resolvedProjectDir = realpathSync(projectDir);
  const resolvedMountDir = path.resolve(mountDir);
  const readonlyPatterns = [...options.readonlyPatterns];
  const ignoredPatterns = [...options.ignoredPatterns];
  const readonlyMatcher = createPathMatcher(readonlyPatterns);
  const ignoredMatcher = createPathMatcher(ignoredPatterns);
  const excludeSet = new Set(
    [...DEFAULT_EXCLUDED_DIRS, ...options.excludeDirs]
      .map((entry) => normalizeRelativePosix(entry).replace(/^\/+|\/+$/g, ''))
      .filter(Boolean)
  );

  if (resolvedMountDir === resolvedProjectDir) {
    throw new Error('mountDir must be different from projectDir');
  }

  removeMountDir(resolvedMountDir);
  mkdirSync(resolvedMountDir, { recursive: true });
  const realMountDir = realpathSync(resolvedMountDir);

  walkProjectTree(
    resolvedProjectDir,
    resolvedProjectDir,
    realMountDir,
    excludeSet,
    readonlyMatcher,
    ignoredMatcher
  );

  const permissionsDocPath = resolveSafeCopyTarget(realMountDir, path.join(realMountDir, '_PERMISSIONS.md'));
  if (!permissionsDocPath) {
    throw new Error('Failed to create permissions document inside mountDir');
  }

  writeFileSync(
    permissionsDocPath,
    buildPermissionDoc(PERMISSIONS_AGENT_NAME, readonlyPatterns, ignoredPatterns),
    'utf8'
  );

  return {
    mountDir: resolvedMountDir,
    async syncBack(): Promise<number> {
      let synced = 0;
      const realProjectDir = realpathSync(resolvedProjectDir);
      const realMountDir = realpathSync(resolvedMountDir);
      const files = listFiles(realMountDir);

      for (const sourceFile of files) {
        synced += syncMountedFileBack(
          sourceFile,
          realMountDir,
          realProjectDir,
          readonlyMatcher,
          ignoredMatcher
        );
      }

      return synced;
    },
    cleanup(): void {
      removeMountDir(resolvedMountDir);
    },
  };
}

function walkProjectTree(
  projectDir: string,
  currentDir: string,
  mountDir: string,
  excludeSet: Set<string>,
  readonlyMatcher: Ignore,
  ignoredMatcher: Ignore
): void {
  const entries = readdirSync(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    const relativePath = normalizeRelativePosix(path.relative(projectDir, absolutePath));

    if (!relativePath || relativePath.startsWith('..')) {
      continue;
    }

    if (isPathWithinRoot(absolutePath, mountDir)) {
      continue;
    }

    if (isExcludedPath(relativePath, excludeSet)) {
      continue;
    }

    if (isPathMatched(relativePath, ignoredMatcher, entry.isDirectory())) {
      continue;
    }

    const mountPath = path.join(mountDir, relativePath);

    if (entry.isDirectory()) {
      if (!ensureDirectoryWithinRoot(mountDir, mountPath)) {
        continue;
      }
      walkProjectTree(projectDir, absolutePath, mountDir, excludeSet, readonlyMatcher, ignoredMatcher);
      continue;
    }

    if (entry.isSymbolicLink()) {
      copySymlinkedFile(projectDir, mountDir, absolutePath, mountPath, relativePath, readonlyMatcher);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    copyMountedFile(projectDir, mountDir, absolutePath, mountPath, relativePath, readonlyMatcher);
  }
}

function copySymlinkedFile(
  projectDir: string,
  mountDir: string,
  sourcePath: string,
  mountPath: string,
  relativePath: string,
  readonlyMatcher: Ignore
): void {
  let realSource: string;
  let resolvedStat: Stats;
  try {
    realSource = realpathSync(sourcePath);
    resolvedStat = statSync(sourcePath);
  } catch {
    return;
  }

  if (!isPathWithinRoot(realSource, projectDir) || !resolvedStat.isFile()) {
    return;
  }

  copyMountedFile(
    projectDir,
    mountDir,
    realSource,
    mountPath,
    relativePath,
    readonlyMatcher,
    resolvedStat.mode
  );
}

function copyMountedFile(
  sourceRoot: string,
  mountDir: string,
  sourcePath: string,
  mountPath: string,
  relativePath: string,
  readonlyMatcher: Ignore,
  sourceMode?: number
): void {
  const safeMountPath = resolveSafeCopyTarget(mountDir, mountPath);
  if (!safeMountPath) {
    return;
  }

  const safeSourcePath = resolveVerifiedFilePath(sourceRoot, sourcePath);
  if (!safeSourcePath) {
    return;
  }

  copyFileSync(safeSourcePath, safeMountPath);

  if (isPathMatched(relativePath, readonlyMatcher)) {
    chmodSync(safeMountPath, 0o444);
    return;
  }

  const mode = sourceMode ?? statSync(safeSourcePath).mode;
  chmodSync(safeMountPath, mode & 0o777);
}

function ensureDirectory(pathValue: string): void {
  mkdirSync(pathValue, { recursive: true });
}

function ensureDirectoryWithinRoot(rootPath: string, dirPath: string): boolean {
  if (!isPathWithinRoot(dirPath, rootPath)) {
    return false;
  }

  try {
    ensureDirectory(dirPath);
    const realDir = realpathSync(dirPath);
    return isPathWithinRoot(realDir, rootPath);
  } catch {
    return false;
  }
}

function listFiles(baseDir: string): string[] {
  const files: string[] = [];
  const stack = [baseDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.relay') continue;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(entryPath);
      }
    }
  }
  return files;
}

function normalizeRelativePosix(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function createPathMatcher(patterns: string[]): Ignore {
  return ignore().add(
    patterns.map((pattern) => pattern.trim()).filter((pattern) => pattern !== '' && !pattern.startsWith('#'))
  );
}

function isPathMatched(relPath: string, matcher: Ignore, isDirectory = false): boolean {
  const normalized = normalizeRelativePosix(relPath);
  return matcher.ignores(normalized) || (isDirectory && matcher.ignores(`${normalized}/`));
}

function hasSameContent(left: string, right: string): boolean {
  try {
    const leftContent = readFileSync(left);
    const rightContent = readFileSync(right);
    return leftContent.equals(rightContent);
  } catch {
    return false;
  }
}

function syncMountedFileBack(
  sourceFile: string,
  mountDir: string,
  projectDir: string,
  readonlyMatcher: Ignore,
  ignoredMatcher: Ignore
): number {
  const relative = resolveSyncRelativePath(sourceFile, mountDir, readonlyMatcher, ignoredMatcher);
  if (!relative) return 0;

  const safeTargetPath = resolveVerifiedSyncTarget(projectDir, relative);
  if (!safeTargetPath) return 0;

  if (existsSync(safeTargetPath) && hasSameContent(sourceFile, safeTargetPath)) {
    return 0;
  }

  copyFileSync(sourceFile, safeTargetPath);
  return 1;
}

function resolveSyncRelativePath(
  sourceFile: string,
  mountDir: string,
  readonlyMatcher: Ignore,
  ignoredMatcher: Ignore
): string | null {
  const relative = path.relative(mountDir, sourceFile);
  if (relative === '' || relative.startsWith('..')) return null;
  if (relative === '.agent-relay' || normalizeRelativePosix(relative) === '_PERMISSIONS.md') return null;
  if (isPathMatched(relative, readonlyMatcher) || isPathMatched(relative, ignoredMatcher)) return null;

  try {
    if (lstatSync(sourceFile).isSymbolicLink()) return null;

    const realSource = realpathSync(sourceFile);
    if (!isPathWithinRoot(realSource, mountDir)) return null;
  } catch {
    return null;
  }

  return relative;
}

function resolveVerifiedSyncTarget(projectDir: string, relativePath: string): string | null {
  const targetPath = path.resolve(projectDir, relativePath);
  if (!isPathWithinRoot(targetPath, projectDir)) return null;

  const safeTargetPath = resolveSafeCopyTarget(projectDir, targetPath);
  if (!safeTargetPath || !existsSync(safeTargetPath)) {
    return safeTargetPath;
  }

  try {
    const targetStat = lstatSync(safeTargetPath);
    if (targetStat.isSymbolicLink()) return null;

    const realTarget = realpathSync(safeTargetPath);
    return isPathWithinRoot(realTarget, projectDir) ? safeTargetPath : null;
  } catch {
    return null;
  }
}

function isExcludedPath(relativePath: string, excludeSet: Set<string>): boolean {
  const normalized = normalizeRelativePosix(relativePath).replace(/^\/+|\/+$/g, '');
  if (!normalized) return false;
  const segments = normalized.split('/');
  return segments.some((segment, index) => {
    const prefix = segments.slice(0, index + 1).join('/');
    return excludeSet.has(segment) || excludeSet.has(prefix);
  });
}

function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  const resolvedCandidate = path.resolve(candidatePath);
  const resolvedRoot = path.resolve(rootPath);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

function resolveSafeCopyTarget(rootPath: string, candidatePath: string): string | null {
  if (!isPathWithinRoot(candidatePath, rootPath)) {
    return null;
  }

  const parentPath = path.dirname(candidatePath);
  if (!ensureDirectoryWithinRoot(rootPath, parentPath)) {
    return null;
  }

  try {
    const realParent = realpathSync(parentPath);
    if (!isPathWithinRoot(realParent, rootPath)) {
      return null;
    }

    return path.join(realParent, path.basename(candidatePath));
  } catch {
    return null;
  }
}

function resolveVerifiedFilePath(rootPath: string, candidatePath: string): string | null {
  try {
    const realCandidate = realpathSync(candidatePath);
    const candidateStat = statSync(candidatePath);
    if (!candidateStat.isFile()) {
      return null;
    }

    return isPathWithinRoot(realCandidate, rootPath) ? realCandidate : null;
  } catch {
    return null;
  }
}

function removeMountDir(mountDir: string): void {
  if (!existsSync(mountDir)) {
    return;
  }

  try {
    rmSync(mountDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }
}

function buildPermissionDoc(
  agentName: string,
  readonlyPatterns: string[],
  ignoredPatterns: string[]
): string {
  const readonlyList = readonlyPatterns.length > 0 ? readonlyPatterns.join('\n') : '(none)';
  const ignoredList = ignoredPatterns.length > 0 ? ignoredPatterns.join('\n') : '(none)';
  return `# Workspace Permissions

This workspace is managed by the relay.
File access is controlled by project-local .agentignore and .agentreadonly.

## Read-only files (cannot be modified)
${readonlyList || '(none)'}

## Hidden files (not available in this workspace)
${ignoredList || '(none)'}

## Writable files
All other files can be read and modified freely.

If you get "permission denied", the file is read-only.
Changes to read-only files will be automatically reverted.
Do not attempt to chmod files - permissions will be restored.

Agent: ${agentName}
`;
}
