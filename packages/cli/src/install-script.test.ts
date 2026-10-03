import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const installScriptPath = fileURLToPath(new URL('../../../install.sh', import.meta.url));
const installScript = fs.readFileSync(installScriptPath, 'utf-8');

/** Body of a top-level shell function: from `name() {` to the next `}` in column 0. */
function fnBody(name: string): string {
  const match = installScript.match(new RegExp(`^${name}\\(\\)\\s*\\{\\n([\\s\\S]*?)^\\}`, 'm'));
  if (!match) throw new Error(`function ${name}() not found in install.sh`);
  return match[1];
}

/** Index of the first line (call or definition use) matching `re`, or -1. */
function at(body: string, re: RegExp): number {
  const m = body.match(re);
  return m ? (m.index ?? -1) : -1;
}

describe('install.sh', () => {
  describe('macOS prepare step', () => {
    const body = fnBody('prepare_downloaded_binary');

    it('strips quarantine, then verifies the signature of the downloaded file before any signing', () => {
      const quarantine = at(body, /xattr -d com\.apple\.quarantine "\$f"/);
      const verify = at(body, /codesign --verify --strict "\$f"/);
      const sign = at(body, /codesign --force --sign - "\$f"/);
      expect(quarantine).toBeGreaterThanOrEqual(0);
      expect(verify).toBeGreaterThan(quarantine);
      expect(sign).toBeGreaterThan(verify);
    });

    it('re-signs only a binary that ships unsigned, and a failed signing rejects it', () => {
      // exactly one signing call in the whole function
      const signCalls = body.match(/codesign --force --sign/g) ?? [];
      expect(signCalls).toHaveLength(1);
      // ... and it lives inside the "not signed at all" arm (between its pattern and its `;;`)
      const arm = body.match(/\*"not signed at all"\*\)([\s\S]*?);;/);
      expect(arm).not.toBeNull();
      expect(arm![1]).toMatch(/codesign --force --sign - "\$f"/);
      // the signing status is checked (not swallowed with `|| true`) and failure returns non-zero
      expect(arm![1]).toMatch(/if codesign --force --sign - "\$f"[^\n]*; then\s*return 0\s*fi/);
      expect(arm![1]).toMatch(/fi[\s\S]*return 1/);
      expect(arm![1]).not.toMatch(/\|\|\s*true/);
      // every other signature failure falls through to a rejection with no signing
      const afterCase = body.slice(body.indexOf('esac'));
      expect(afterCase).toMatch(/return 1/);
      expect(afterCase).not.toMatch(/codesign --force/);
    });

    it('fails closed when codesign is missing and no digest was verified', () => {
      const missing = body.match(/if ! has_command codesign; then([\s\S]*?)\n    fi\n/);
      expect(missing).not.toBeNull();
      expect(missing![1]).toMatch(/DIGEST_VERIFIED/);
      expect(missing![1]).toMatch(/return 1/);
    });

    it('no longer re-signs unconditionally via strip_quarantine', () => {
      expect(installScript).not.toMatch(/^strip_quarantine\(\)/m);
      expect(installScript).not.toMatch(/codesign --remove-signature/);
    });
  });

  describe('atomic install', () => {
    const body = fnBody('install_binary_atomic');

    it('prepares and checks the temp file before the destination is touched, then renames atomically', () => {
      const prepare = at(body, /prepare_downloaded_binary "\$tmp"/);
      const check = at(body, /"\$check_fn" "\$tmp"/);
      const rename = at(body, /mv -f "\$tmp" "\$dest"/);
      expect(prepare).toBeGreaterThanOrEqual(0);
      expect(check).toBeGreaterThan(prepare);
      expect(rename).toBeGreaterThan(check);
    });

    it('keeps a backup and verifies the installed bytes by hash after the rename', () => {
      const rename = at(body, /mv -f "\$tmp" "\$dest"/);
      expect(at(body, /prev="\$\{dest\}\$\{BACKUP_SUFFIX:-\.prev\}"/)).toBeGreaterThanOrEqual(0);
      expect(at(body, /sha256_of "\$dest"/)).toBeGreaterThan(rename);
      expect(body).toMatch(/mv -f "\$prev" "\$dest"/);
    });

    it('never writes, copies onto or signs the destination directly', () => {
      expect(body).not.toMatch(/(>|-o)\s*"\$dest"/);
      expect(body).not.toMatch(/codesign[^\n]*"\$dest"/);
      expect(body).not.toMatch(/cp [^\n]*"\$dest"\s*$/m);
    });
  });

  describe('download_broker_binary', () => {
    const body = fnBody('download_broker_binary');

    it('fetches into a temp file, then installs atomically with the smoke-test check', () => {
      const fetch = at(body, /fetch_release_asset /);
      const install = at(body, /install_binary_atomic "\$FETCHED_TMP" "\$d1" check_broker_binary/);
      expect(fetch).toBeGreaterThanOrEqual(0);
      expect(install).toBeGreaterThan(fetch);
    });

    it('never writes or signs the live path directly', () => {
      expect(body).not.toMatch(/-o\s*"\$target_path"/);
      expect(body).not.toMatch(/>\s*"\$target_path"/);
      expect(body).not.toMatch(/codesign[^\n]*"\$target_path"/);
      expect(body).not.toMatch(/"\$target_path" --help/);
    });

    it('copies to BIN_DIR through the atomic path, not a bare cp', () => {
      expect(body).toMatch(/copy_binary_atomic "\$d1" "\$d2"/);
      expect(body).not.toMatch(/^\s*cp /m);
    });
  });

  describe('install transaction', () => {
    it('signal handler snapshots the transaction once and undoes both brokers and the CLI', () => {
      const body = fnBody('handle_signal');
      expect(body).toMatch(/local st="\$TXN_STATE"/);
      expect(body).toMatch(/undo_brokers/);
      expect(body).toMatch(/undo_cli/);
      expect(body).toMatch(/cleanup_temp_files/);
    });

    it('commits with a single TXN_STATE assignment before any backup cleanup', () => {
      const body = fnBody('main');
      const commit = at(body, /# COMMIT[\s\S]*?TXN_STATE=""/);
      const cleanup = at(body, /cleanup_broker_backups/);
      expect(commit).toBeGreaterThanOrEqual(0);
      expect(cleanup).toBeGreaterThan(commit);
    });
  });

  describe('verification before install', () => {
    it('fetch_release_asset checks the release digest on the downloaded temp file', () => {
      const body = fnBody('fetch_release_asset');
      const download = at(body, /curl -fsSL "\$url" -o "\$dl"/);
      const digest = at(body, /verify_asset_digest "\$asset" "\$dl"/);
      expect(download).toBeGreaterThanOrEqual(0);
      expect(digest).toBeGreaterThan(download);
    });

    it('check_broker_binary runs a real init smoke test, not only --help', () => {
      const check = fnBody('check_broker_binary');
      expect(check).toMatch(/smoke_test_broker "\$1"/);
      const smoke = fnBody('smoke_test_broker_run');
      expect(smoke).toMatch(/env -i/);
      expect(smoke).toMatch(/"\$bin" init /);
      expect(smoke).toMatch(/--api-port 0/);
      expect(smoke).toMatch(/RELAY_BASE_URL=/);
    });

    it('the standalone CLI and relay-acp also install through install_binary_atomic', () => {
      expect(fnBody('download_standalone_binary')).toMatch(
        /install_binary_atomic "\$FETCHED_TMP" "\$target_path" check_cli_binary/
      );
      expect(fnBody('download_relay_acp')).toMatch(
        /install_binary_atomic "\$FETCHED_TMP" "\$target_path" check_help_binary/
      );
    });
  });
});
