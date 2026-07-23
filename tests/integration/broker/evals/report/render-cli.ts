/**
 * Regenerate an HTML report from an existing JSON report file.
 *
 *   node dist/evals/report/render-cli.js <path-to-report.json>
 *
 * Writes a sibling .html next to the JSON and prints its path.
 */
import fs from 'node:fs';

import { renderReportHtml } from './html.js';
import { readReport } from './write.js';

function main(): void {
  const input = process.argv[2];
  if (!input) {
    console.error('Usage: render-cli <path-to-report.json>');
    process.exit(2);
  }
  const report = readReport(input);
  const out = input.replace(/\.json$/, '') + '.html';
  fs.writeFileSync(out, renderReportHtml(report));
  console.log(`html → ${out}`);
}

main();
