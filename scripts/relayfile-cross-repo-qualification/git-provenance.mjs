const BUNDLE_TIMEOUT_MS = 900_000;

function gitOptions() {
  return { timeout: BUNDLE_TIMEOUT_MS, killSignal: 'SIGKILL' };
}

const gitStatus = (execFileAsync, repo) =>
  execFileAsync('git', ['-C', repo, 'status', '--porcelain=v1', '--untracked-files=all'], gitOptions());

const gitHead = (execFileAsync, repo) =>
  execFileAsync('git', ['-C', repo, 'rev-parse', 'HEAD'], gitOptions());

function requireHead(name, output) {
  const head = String(output ?? '').trim();
  if (!/^[0-9a-f]{40}$/.test(head))
    throw new Error(`${name} candidate git HEAD is not a full 40-hex commit; bundle creation is blocked`);
  return head;
}

/** Capture clean candidate state before creating any archive bytes. */
export async function captureGitProvenance(candidates, { execFileAsync }) {
  const captured = {};
  for (const [name, repo] of Object.entries(candidates)) {
    let status;
    try {
      status = await gitStatus(execFileAsync, repo);
    } catch {
      throw new Error(`${name} candidate git status could not be read; bundle creation is blocked`);
    }
    if (String(status.stdout ?? '').trim())
      throw new Error(`${name} candidate is dirty; bundle creation is blocked before sandbox creation`);
    let head;
    try {
      ({ stdout: head } = await gitHead(execFileAsync, repo));
    } catch {
      throw new Error(`${name} candidate git HEAD could not be read; bundle creation is blocked`);
    }
    captured[name] = { name, repo, head: requireHead(name, head), clean: true };
  }
  return captured;
}

/** Recheck candidates after all archive and mount bytes are built. */
export async function verifyGitProvenance(candidates, captured, { execFileAsync }) {
  for (const [name, repo] of Object.entries(candidates)) {
    let status;
    try {
      status = await gitStatus(execFileAsync, repo);
    } catch {
      throw new Error(`${name} candidate git status could not be rechecked; bundle creation is blocked`);
    }
    if (String(status.stdout ?? '').trim())
      throw new Error(`${name} candidate became dirty during bundle creation; bundle is invalid`);
    let head;
    try {
      ({ stdout: head } = await gitHead(execFileAsync, repo));
    } catch {
      throw new Error(`${name} candidate git HEAD could not be rechecked; bundle creation is blocked`);
    }
    const finalHead = requireHead(name, head);
    if (captured?.[name]?.head !== finalHead)
      throw new Error(`${name} candidate git HEAD changed during bundle creation; bundle is invalid`);
    if (captured?.[name]?.clean !== true)
      throw new Error(`${name} candidate captured provenance was not clean; bundle is invalid`);
  }
  return captured;
}
