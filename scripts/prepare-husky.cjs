#!/usr/bin/env node

const { spawnSync } = require("node:child_process");

const isCi = process.env.CI === "true" || process.env.CI === "1";
if (isCi || process.env.HUSKY === "0") {
  process.exit(0);
}

try {
  require.resolve("husky/package.json");
} catch {
  process.exit(0);
}

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(npx, ["--no-install", "husky"], { stdio: "inherit" });
if (typeof result.status === "number") {
  process.exit(result.status);
}
process.exit(1);
