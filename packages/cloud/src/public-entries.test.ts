import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('resolves the published Cloud and SDK fleet/attach ESM entries after build', () => {
  for (const name of ['cloud', 'sdk']) {
    const manifest = JSON.parse(readFileSync(new URL(`../../${name}/package.json`, import.meta.url), 'utf8'));
    for (const subpath of ['fleet', 'attach']) {
      const entry = manifest.exports[`./${subpath}`];
      expect(entry.types).toBe(`./dist/${subpath}.d.ts`);
      expect(entry.import).toBe(`./dist/${subpath}.js`);
      expect(readFileSync(new URL(`../../${name}/${entry.types}`, import.meta.url), 'utf8')).toBeTruthy();
      const exportedFunction = subpath === 'attach' ? 'startFleetNodeAttachProxy' : 'ensureCloudFleetSandbox';
      expect(
        execFileSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `import { ${exportedFunction} } from '@agent-relay/${name}/${subpath}'; console.log(typeof ${exportedFunction});`,
          ],
          { cwd: fileURLToPath(new URL('../../..', import.meta.url)), encoding: 'utf8' }
        ).trim()
      ).toBe('function');
    }
  }
});
