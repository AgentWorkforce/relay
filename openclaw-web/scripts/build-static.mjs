import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const skillPath = path.resolve(__dirname, "../../packages/openclaw/skill/SKILL.md");
const outputDir = path.resolve(__dirname, "../site");
const outputFile = path.join(outputDir, "index.html");

const markdown = fs.readFileSync(skillPath, "utf8");

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Agent Relay for OpenClaw</title>
    <style>
      :root {
        color-scheme: light;
      }
      body {
        margin: 0;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        background: #f7f7f5;
        color: #1f2937;
      }
      main {
        box-sizing: border-box;
        max-width: 980px;
        margin: 0 auto;
        padding: 24px 16px 40px;
      }
      h1 {
        font-size: 1.4rem;
        margin: 0 0 12px;
      }
      pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        line-height: 1.45;
        border: 1px solid #d1d5db;
        border-radius: 10px;
        background: #ffffff;
        padding: 16px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Agent Relay for OpenClaw</h1>
      <pre>${escapeHtml(markdown)}</pre>
    </main>
  </body>
</html>`;

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(outputFile, html);
