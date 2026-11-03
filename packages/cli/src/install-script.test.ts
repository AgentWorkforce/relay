import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { INSTALLER_LAUNCHER_MARKER } from './cli/lib/core-maintenance.js';

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
      const missing = body.match(/if ! has_command codesign; then([\s\S]*?)\n {4}fi\n/);
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

  describe('retired broker', () => {
    it('never downloads, runs or installs an agent-relay-broker', () => {
      for (const fn of [
        'download_broker_binary',
        'check_broker_binary',
        'smoke_test_broker',
        'undo_brokers',
      ]) {
        expect(installScript).not.toMatch(new RegExp(`^${fn}\\(\\)`, 'm'));
      }
      // The only mentions left say an older release's broker is left alone.
      const mentions = installScript.split('\n').filter((line) => /broker/i.test(line));
      expect(mentions.length).toBeGreaterThan(0);
      expect(mentions.every((line) => line.trimStart().startsWith('#'))).toBe(true);
    });
  });

  describe('install transaction', () => {
    it('signal handler snapshots the transaction once and undoes the CLI', () => {
      const body = fnBody('handle_signal');
      expect(body).toMatch(/local st="\$TXN_STATE"/);
      expect(body).toMatch(/undo_cli/);
      expect(body).toMatch(/cleanup_temp_files/);
    });

    it('commits with a single TXN_STATE assignment before any backup cleanup', () => {
      const body = fnBody('main');
      const commit = at(body, /# COMMIT[\s\S]*?TXN_STATE=""/);
      const cleanup = at(body, /rm -f "\$INSTALL_DIR\/bin\/agent-relay\$\{TXN_SUFFIX\}"/);
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

    it('the standalone CLI and relay-acp also install through install_binary_atomic', () => {
      expect(fnBody('download_standalone_binary')).toMatch(
        /install_binary_atomic "\$FETCHED_TMP" "\$target_path" check_cli_binary/
      );
      expect(fnBody('download_relay_acp')).toMatch(
        /install_binary_atomic "\$FETCHED_TMP" "\$target_path" check_help_binary/
      );
    });
  });

  describe('single install location', () => {
    it('installs under AGENT_RELAY_INSTALL_DIR, else AGENT_RELAY_HOME, else ~/.agentworkforce/relay', () => {
      expect(installScript).toMatch(
        /^INSTALL_DIR="\$\(normalize_install_root "\$\{AGENT_RELAY_INSTALL_DIR:-\}"\)"$/m
      );
      expect(installScript).toMatch(
        /^\[ -n "\$INSTALL_DIR" \] \|\| INSTALL_DIR="\$\(normalize_install_root "\$\{AGENT_RELAY_HOME:-\}"\)"$/m
      );
      expect(installScript).toMatch(/^\[ -n "\$INSTALL_DIR" \] \|\| INSTALL_DIR="\$DEFAULT_INSTALL_DIR"$/m);
      expect(installScript).toMatch(/^DEFAULT_INSTALL_DIR="\$HOME\/\.agentworkforce\/relay"$/m);
    });

    it('exports a relocated install root from both the binary and the source launcher', () => {
      expect(fnBody('install_binary_launcher')).toMatch(/\$\(launcher_env_lines\)/);
      expect(fnBody('install_node_launcher')).toMatch(/\$\(launcher_env_lines\)/);
    });

    it('marks both launchers and writes the short relay launcher with the same body', () => {
      expect(fnBody('install_binary_launcher')).toMatch(/^\$LAUNCHER_MARKER$/m);
      expect(fnBody('install_node_launcher')).toMatch(/^\$LAUNCHER_MARKER$/m);
      expect(fnBody('write_launchers')).toMatch(/write_executable_file "\$BIN_DIR\/agent-relay"/);
      expect(fnBody('write_launchers')).toMatch(/write_executable_file "\$BIN_DIR\/relay"/);
    });

    it('uses the launcher marker that `agent-relay uninstall` looks for', () => {
      expect(installScript).toContain(`LAUNCHER_MARKER="${INSTALLER_LAUNCHER_MARKER}"`);
    });

    it('never deletes the install root when replacing a source checkout', () => {
      const body = fnBody('install_from_source');
      expect(body).toMatch(/local source_dir="\$INSTALL_DIR\/source"/);
      expect(body).not.toMatch(/rm -rf "\$INSTALL_DIR"/);
    });

    it('bounds both optional relaycast-engine downloads', () => {
      const curls = fnBody('install_relaycast_engine').match(/curl [^\n]*/g) ?? [];
      expect(curls).toHaveLength(2);
      for (const call of curls) {
        expect(call).toMatch(/--connect-timeout \d+/);
        expect(call).toMatch(/--max-time \d+/);
      }
    });

    it('pins relaycast-engine in exactly one place', () => {
      expect(installScript.match(/^RELAYCAST_ENGINE_VERSION=/gm)).toHaveLength(1);
      expect(installScript).toMatch(/^RELAYCAST_ENGINE_VERSION="\d+\.\d+\.\d+"$/m);
    });

    it('downloads relaycast-engine into the canonical bin dir through the atomic path', () => {
      const body = fnBody('install_relaycast_engine');
      expect(body).toMatch(/relaycast-engine-\$\{RELAYCAST_ENGINE_VERSION\}-\$\{OS\}-\$\{ARCH\}/);
      expect(body).toMatch(/local target="\$INSTALL_DIR\/bin\/relaycast-engine"/);
      expect(body).toMatch(/\.sha256/);
      expect(body).toMatch(/install_binary_atomic "\$dl" "\$target"/);
      // Never fatal: every path returns 0.
      expect(body).not.toMatch(/\berror\b|return 1/);
    });

    it('installs relaycast-engine on both the standalone and npm paths', () => {
      expect(fnBody('main')).toMatch(/install_relaycast_engine/);
      expect(fnBody('install_via_npm')).toMatch(/install_relaycast_engine/);
    });
  });
});
