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
      /download_broker_binary\(\)\s*\{[\s\S]*strip_quarantine "\$target_path"[\s\S]*"\$target_path" --help/
    );
  });
});
