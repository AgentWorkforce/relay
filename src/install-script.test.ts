import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const installScriptPath = fileURLToPath(new URL('../install.sh', import.meta.url));
const installScript = fs.readFileSync(installScriptPath, 'utf-8');

describe('install.sh', () => {
  it('re-signs downloaded macOS binaries before verification', () => {
    expect(installScript).toMatch(/strip_quarantine\(\)\s*\{[\s\S]*codesign --force --sign - "\$1"/);
  });

  it('prepares the broker binary before running the verification command', () => {
    expect(installScript).toMatch(
      /download_broker_binary\(\)\s*\{[\s\S]*strip_quarantine "\$target_path"[\s\S]*verify_downloaded_executable "\$target_path" "--help" "Downloaded broker binary"/
    );
  });

  it('installs stable launchers after npm install instead of trusting the npm shim alone', () => {
    expect(installScript).toMatch(
      /install_npm_launchers\(\)\s*\{[\s\S]*write_launcher "\$BIN_DIR\/agent-relay" "\$cli_path" "node"[\s\S]*is_replaceable_agent_relay_launcher "\$npm_launcher_path"[\s\S]*write_launcher "\$npm_launcher_path" "\$cli_path" "node"/
    );
  });

  it('resolves the npm global bin dir without calling the noisy check_node logger', () => {
    const functionMatch = installScript.match(/get_npm_global_bin_dir\(\)\s*\{([\s\S]*?)\n\}/);
    expect(functionMatch?.[1]).toBeTruthy();
    expect(functionMatch?.[1]).toMatch(/has_command node/);
    expect(functionMatch?.[1]).toMatch(/has_command npm/);
    expect(functionMatch?.[1]).toMatch(/node_major=/);
    expect(functionMatch?.[1]).not.toMatch(/check_node/);
  });

  it('replaces stale launcher symlinks and warns if PATH is shadowed by one', () => {
    expect(installScript).toMatch(
      /is_broken_symlink\(\)\s*\{[\s\S]*write_launcher\(\)\s*\{[\s\S]*Removing stale launcher symlink at \$launcher_path/
    );
    expect(installScript).toMatch(
      /verify_installation\(\)\s*\{[\s\S]*A stale agent-relay symlink at \$which_path is shadowing/
    );
  });

  it('marks managed launchers and keeps standalone binaries under the managed install dir', () => {
    expect(installScript).toMatch(/write_launcher\(\)\s*\{[\s\S]*agent-relay-managed-launcher/);
    expect(installScript).toMatch(
      /install_managed_binary_with_launcher\(\)\s*\{[\s\S]*local managed_dir="\$INSTALL_DIR\/bin"[\s\S]*write_launcher "\$BIN_DIR\/\$launcher_name" "\$managed_path" "binary"/
    );
    expect(installScript).toMatch(
      /download_standalone_binary\(\)\s*\{[\s\S]*install_managed_binary_with_launcher "\$target_path" "agent-relay" "agent-relay"/
    );
  });

  it('does not overwrite an unrelated npm-bin command when installing a stable launcher', () => {
    expect(installScript).toMatch(
      /install_npm_launchers\(\)\s*\{[\s\S]*Leaving existing agent-relay command at \$npm_launcher_path untouched; using managed launcher at \$BIN_DIR\/agent-relay/
    );
  });

  it('surfaces a specific macOS verification warning when a downloaded binary is killed', () => {
    expect(installScript).toMatch(
      /verify_downloaded_executable\(\)\s*\{[\s\S]*"\$OS" = "darwin"[\s\S]*"\$status" -eq 137[\s\S]*LAST_VERIFY_FAILURE_REASON="macos_killed"[\s\S]*killed by macOS during verification/
    );
    expect(installScript).toMatch(
      /download_standalone_binary\(\)\s*\{[\s\S]*STANDALONE_BINARY_FAILURE_REASON="macos_killed"[\s\S]*Standalone binary verification failed on macOS\. Falling back to npm\/source/
    );
  });
});
