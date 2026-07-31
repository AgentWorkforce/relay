/**
 * Filesystem confinement — bind a write to a directory it cannot escape.
 *
 * An authorization layer decides whether an agent *may* write `docs/x.md`. This
 * decides whether the concrete path is *safe to write*. Two independent gates,
 * both fail closed, in that order — neither substitutes for the other. Policy
 * that says "allowed" is not a filesystem guarantee: the path can be a symlink,
 * a hardlink to something outside, or replaced a microsecond after the check.
 *
 * Originated in the Agent Relay x Ratify design-partner spike, where four
 * distinct defects were found in it by adversarial testing — three by us and one
 * by Identities AI. Every one was platform- or timing-dependent and none would
 * have been caught by asserting on the return value alone. The test suite that
 * found them ships alongside as fs-confine.test.ts.
 *
 * ═══ THREAT MODEL ═══════════════════════════════════════════════════════════
 *
 * Stated first because every design choice below follows from it, and because
 * three rounds of defects here were all cases of patching a symptom without
 * naming the adversary.
 *
 * **The adversary is a concurrent mutator**: any process that can create,
 * rename, unlink, or replace objects underneath the confinement root *while a
 * write is in progress*. It does not need to be privileged and it does not need
 * to win a tight race repeatedly — a single successful swap between any two
 * syscalls is enough. It may act on intermediate directories, on the final
 * component, or on both, and it may pre-place objects (files, symlinks,
 * hardlinks, fifos) outside the root to be selected by a swap.
 *
 * Out of scope: an adversary who can already write *through* the confinement
 * layer, modify this process's memory, or replace the root itself before
 * construction. Those are not filesystem races; they are prior compromise.
 *
 * **Two contracts, deliberately separated.** Conflating them is what produced
 * the destructive-refusal defect:
 *
 *   C1 — SECURITY REFUSAL. If this layer refuses a write for any confinement or
 *        policy reason, there is **no externally observable filesystem
 *        mutation**. Nothing created, nothing truncated, nothing unlinked,
 *        inside or outside the root. A refusal that destroys data is worse than
 *        the write it prevented.
 *
 *   C2 — WRITE ATOMICITY. Once an authorized write begins, the target is either
 *        fully replaced or left exactly as it was. No partial content, no
 *        zero-length window. Implemented by writing to a temporary file in the
 *        pinned parent directory and renaming over the target, with a write
 *        loop that does not treat a short write as success.
 *
 * C1 is unconditional. C2 covers I/O failure after authorization; it does not
 * promise anything about an adversary who is *also* racing the rename.
 *
 * ═══ WHY DESCRIPTOR-RELATIVE ════════════════════════════════════════════════
 *
 * A path is a *query*, re-evaluated by the kernel on every syscall, and the
 * adversary controls what it resolves to between one call and the next. A
 * descriptor is a *reference* to one object. Any check made against a path and
 * then acted on by path is inherently a race; that is the entire defect class,
 * and no amount of re-verification closes it, because re-verification is itself
 * path-based.
 *
 * So: resolve every component **relative to the descriptor of the component
 * before it**, starting from a descriptor for the root captured once at
 * construction. The adversary can still swap `docs` on disk, but our `docs`
 * descriptor keeps pointing at the directory we validated, and the next
 * component is opened relative to *that*, not to a path that now means
 * something else.
 *
 * Node 22 exposes no `openat(2)`. Two resolution modes result, and the
 * difference is a real difference in guarantee, not an implementation detail:
 *
 *   - `descriptor-relative` (Linux): `/proc/self/fd/<dirfd>/<name>` is resolved
 *     by the kernel *from the descriptor*, giving true `openat` semantics. The
 *     race class is closed. A native `openat2` binding with `RESOLVE_BENEATH |
 *     RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS` would be strictly better and
 *     is the right answer for production; this is the portable-Node equivalent.
 *
 *   - `pinned-path` (macOS, others): no procfs, so the final operations are
 *     path-based. Pinned descriptors still prevent inode reuse, so a swap is
 *     *detected* — but detection is not prevention, and a determined racer can
 *     still be acted upon between calls. **In this mode the layer is sound only
 *     under the additional assumption that no untrusted process can mutate the
 *     tree during a write.** If that assumption does not hold, the confinement
 *     boundary must be an OS-level one (mount namespace, jail, container with
 *     the root as its own mount) rather than this layer.
 *
 * `resolutionMode` is reported so callers and tests can assert which guarantee
 * they are actually getting instead of assuming the stronger one.
 */

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { join, sep } from 'node:path';

export type ConfinementCode =
  | 'absolute_path'
  | 'empty_path'
  | 'empty_segment'
  | 'dot_segment'
  | 'nul_byte'
  | 'backslash'
  | 'symlink_component'
  | 'not_a_directory'
  | 'symlink_target'
  | 'not_regular_file'
  | 'hardlink'
  | 'cross_device'
  | 'component_swapped'
  | 'short_write'
  | 'root_unresolvable';

export class ConfinementError extends Error {
  constructor(
    readonly code: ConfinementCode,
    message: string,
  ) {
    super(message);
    this.name = 'ConfinementError';
  }
}

const fail: (code: ConfinementCode, message: string) => never = (code, message) => {
  throw new ConfinementError(code, message);
};

/** Identity of a filesystem object — what containment is tested on. */
interface NodeIdentity {
  dev: number;
  ino: number;
}

const identityOf = (st: Stats): NodeIdentity => ({ dev: Number(st.dev), ino: Number(st.ino) });

const sameIdentity = (a: NodeIdentity, b: NodeIdentity): boolean =>
  a.dev === b.dev && a.ino === b.ino;

export type ResolutionMode = 'descriptor-relative' | 'pinned-path';

/** True where `/proc/self/fd` gives us kernel-side descriptor-relative resolution. */
const PROCFS_AVAILABLE = process.platform === 'linux';

export interface WriteHooks {
  /**
   * Fires after resolution, immediately before the final open. Exists so the
   * TOCTOU cases are deterministic rather than sleep-and-hope. Never set in
   * production.
   */
  beforeOpen?: (resolvedPath: string) => void;
  /** Fires after the descriptor has passed validation, before content is written. */
  afterValidate?: (fd: number) => void;
}

export interface ConfinedWrite {
  relativePath: string;
  bytesWritten: number;
  /** Which guarantee this write actually got. See the threat model. */
  resolutionMode: ResolutionMode;
}

/** A directory we have validated and hold open. */
interface PinnedDir {
  fd: number;
  path: string;
  identity: NodeIdentity;
}

export class ConfinedRoot {
  private readonly root: string;
  private readonly rootIdentity: NodeIdentity;

  /** Held for the lifetime of the object: the anchor every walk starts from. */
  private readonly rootFd: number;

  readonly resolutionMode: ResolutionMode;

  constructor(rootPath: string) {
    let resolved: string;
    try {
      resolved = realpathSync(rootPath);
    } catch (err) {
      fail('root_unresolvable', `confinement root does not resolve: ${(err as Error).message}`);
    }
    this.root = resolved;

    // The root itself being a symlink is legitimate and must keep working
    // (`/var` -> `/private/var` on Darwin). It is resolved exactly once, here,
    // under our control, before any adversary-influenced component appears.
    this.rootFd = openSync(this.root, constants.O_RDONLY | constants.O_DIRECTORY);
    this.rootIdentity = identityOf(fstatSync(this.rootFd));
    this.resolutionMode = PROCFS_AVAILABLE ? 'descriptor-relative' : 'pinned-path';
  }

  get path(): string {
    return this.root;
  }

  /** Release the root anchor. The object is unusable afterwards. */
  close(): void {
    try {
      closeSync(this.rootFd);
    } catch {
      /* already closed */
    }
  }

  /**
   * A path that the kernel resolves relative to `dirFd`, when the platform can.
   * Falls back to a plain join, which is the weaker `pinned-path` mode.
   */
  private at(dir: PinnedDir, name: string): string {
    return PROCFS_AVAILABLE ? `/proc/self/fd/${dir.fd}/${name}` : join(dir.path, name);
  }

  /**
   * Write `contents` to `requestPath` relative to the root.
   *
   * Throws ConfinementError and mutates nothing (contract C1) if the path is not
   * provably safe.
   */
  writeFile(requestPath: string, contents: string, hooks: WriteHooks = {}): ConfinedWrite {
    const segments = this.validateRequestPath(requestPath);
    const pinned: PinnedDir[] = [];
    try {
      return this.writeConfined(segments, contents, hooks, pinned);
    } finally {
      for (const dir of pinned.splice(0)) {
        try {
          closeSync(dir.fd);
        } catch {
          /* already closed */
        }
      }
    }
  }

  private writeConfined(
    segments: string[],
    contents: string,
    hooks: WriteHooks,
    pinned: PinnedDir[],
  ): ConfinedWrite {
    // ── walk, descriptor-relative ────────────────────────────────────────────
    // Each component is opened relative to the descriptor of the one before it.
    // `mkdirSync(recursive)` is never used: it traverses and creates *through* a
    // symlinked component.
    let dir: PinnedDir = { fd: this.rootFd, path: this.root, identity: this.rootIdentity };

    for (const segment of segments.slice(0, -1)) {
      const childPath = this.at(dir, segment);

      const existing = this.lstatOrNull(childPath);
      if (existing === null) {
        mkdirSync(childPath); // one component, no recursion
      } else if (existing.isSymbolicLink()) {
        fail(
          'symlink_component',
          `path component is a symlink and is refused rather than followed: ${segment}`,
        );
      } else if (!existing.isDirectory()) {
        fail('not_a_directory', `path component is not a directory: ${segment}`);
      }

      // O_NOFOLLOW: cannot open a symlink that appeared since the lstat.
      // O_DIRECTORY: cannot open anything that is no longer a directory.
      // Opening relative to `dir.fd` is what makes this immune to `dir` itself
      // being swapped on disk after we pinned it.
      let childFd: number;
      try {
        childFd = openSync(
          childPath,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ELOOP') {
          return fail('symlink_component', `path component became a symlink: ${segment}`);
        }
        if (code === 'ENOTDIR') {
          return fail('not_a_directory', `path component is not a directory: ${segment}`);
        }
        throw err;
      }

      const childStat = fstatSync(childFd);
      const child: PinnedDir = {
        fd: childFd,
        path: join(dir.path, segment),
        identity: identityOf(childStat),
      };
      pinned.push(child);

      if (child.identity.dev !== this.rootIdentity.dev) {
        fail('cross_device', `path component is on a different device: ${segment}`);
      }

      dir = child;
    }

    const finalName = segments[segments.length - 1]!;
    const targetPath = this.at(dir, finalName);

    hooks.beforeOpen?.(targetPath);

    // ── inspect the target WITHOUT creating or modifying it ──────────────────
    //
    // The target is not opened for write, not created, and not truncated at
    // this stage. An earlier version created an O_EXCL placeholder here to
    // learn whether the file was new — which is itself an externally observable
    // mutation, and an adversary can hardlink that placeholder before the
    // refusal removes it. Contract C1 says a refusal mutates nothing, so the
    // target is untouched until the atomic rename at the very end.
    const existing = this.lstatOrNull(targetPath);

    if (existing !== null) {
      if (existing.isSymbolicLink()) {
        fail('symlink_target', `target is a symlink and is refused rather than followed: ${finalName}`);
      }

      // Validate the *descriptor*, opened read-only so inspection cannot
      // destroy anything: O_TRUNC in an open is a mutation that happens before
      // any check can run.
      let probe: number;
      try {
        probe = openSync(targetPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch (err) {
        return this.translateOpenError(err as NodeJS.ErrnoException, finalName);
      }
      try {
        const st = fstatSync(probe);
        if (!st.isFile()) {
          fail('not_regular_file', `target is not a regular file: ${finalName}`);
        }
        if (st.nlink !== 1) {
          // A hardlink inside the root to a file outside it is
          // path-indistinguishable from a legitimate file, and realpath cannot
          // help — a hardlink has no target to resolve.
          fail('hardlink', `target has ${st.nlink} links; refusing to write through a hardlink`);
        }
        if (Number(st.dev) !== this.rootIdentity.dev) {
          fail('cross_device', 'target is on a different device than the root');
        }
      } finally {
        closeSync(probe);
      }
    }

    hooks.afterValidate?.(-1);

    // Re-check the link count immediately before committing: a hardlink can be
    // created after validation.
    if (existing !== null) {
      const now = this.lstatOrNull(targetPath);
      if (now !== null && now.nlink !== 1) {
        fail('hardlink', `target gained ${now.nlink} links after validation`);
      }
    }

    // ── re-verify the pinned walk ───────────────────────────────────────────
    // In descriptor-relative mode this is belt-and-braces. In pinned-path mode
    // it is the actual detection mechanism, and is sound only because each
    // component's inode is pinned by an open descriptor and therefore cannot be
    // freed and recycled for the adversary's replacement.
    for (const step of pinned) {
      const now = this.lstatOrNull(step.path);
      if (now === null || !sameIdentity(identityOf(now), step.identity)) {
        fail(
          'component_swapped',
          `path component changed identity between resolution and open: ${step.path}`,
        );
      }
    }

    // ── commit (contract C2) ────────────────────────────────────────────────
    // Temp file in the *pinned parent*, fully written, then renamed over the
    // target. `rename` replaces the name atomically and does not follow a final
    // symlink, so there is no window in which the target is empty or partial.
    return {
      relativePath: segments.join('/'),
      bytesWritten: this.commit(dir, finalName, contents),
      resolutionMode: this.resolutionMode,
    };
  }

  /**
   * Write via a temporary sibling and rename into place.
   *
   * The temp name is derived from the target and cleaned up on every failure
   * path, so a failed write leaves neither a partial target nor debris.
   */
  private commit(dir: PinnedDir, finalName: string, contents: string): number {
    const tempName = `.${finalName}.c5tmp-${process.pid}`;
    const tempPath = this.at(dir, tempName);
    const targetPath = this.at(dir, finalName);

    const tempFd = openSync(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o644,
    );

    const payload = Buffer.from(contents, 'utf8');
    try {
      // A single writeSync can legally write fewer bytes than asked. Treating
      // its return value as success silently truncates content.
      let written = 0;
      while (written < payload.length) {
        const n = writeSync(tempFd, payload, written, payload.length - written);
        if (n <= 0) {
          fail('short_write', `write stalled after ${written} of ${payload.length} bytes`);
        }
        written += n;
      }
      closeSync(tempFd);

      // Atomic replace. The placeholder created by O_EXCL above (if any) is
      // replaced by this rename, so it needs no separate cleanup.
      renameSync(tempPath, targetPath);
      return written;
    } catch (err) {
      try {
        closeSync(tempFd);
      } catch {
        /* already closed */
      }
      try {
        unlinkSync(tempPath);
      } catch {
        /* best effort */
      }
      throw err;
    }
  }

  private translateOpenError(err: NodeJS.ErrnoException, finalName: string): never {
    if (err.code === 'ELOOP') {
      return fail('symlink_target', `target is a symlink and is refused rather than followed: ${finalName}`);
    }
    if (err.code === 'ENXIO' || err.code === 'ENODEV') {
      // O_NONBLOCK turns "block forever waiting for a fifo reader" into this.
      return fail('not_regular_file', `target is not a regular file: ${finalName}`);
    }
    if (err.code === 'EISDIR') {
      return fail('not_regular_file', `target is a directory: ${finalName}`);
    }
    throw err;
  }

  /**
   * Reject before resolving. No `resolve()`, no normalization, no attempt to
   * decide containment by comparing strings — case-insensitive filesystems make
   * string comparison wrong in both directions. Containment is decided by
   * descriptor-relative traversal, above.
   */
  private validateRequestPath(requestPath: string): string[] {
    if (requestPath === '') fail('empty_path', 'path is empty');
    if (requestPath.includes('\0')) fail('nul_byte', 'path contains a NUL byte');
    if (requestPath.includes('\\')) {
      fail('backslash', "path contains a backslash; '/' is the only separator");
    }
    if (requestPath.startsWith('/') || (sep === '\\' && /^[a-zA-Z]:/.test(requestPath))) {
      fail('absolute_path', `path is absolute and would escape the root: ${requestPath}`);
    }

    const segments = requestPath.split('/');
    for (const segment of segments) {
      if (segment === '') fail('empty_segment', `path has an empty segment: ${requestPath}`);
      if (segment === '.' || segment === '..') {
        fail('dot_segment', `dot-segments are refused, never resolved: ${requestPath}`);
      }
    }
    return segments;
  }

  private lstatOrNull(p: string): Stats | null {
    return lstatSync(p, { throwIfNoEntry: false }) ?? null;
  }
}
