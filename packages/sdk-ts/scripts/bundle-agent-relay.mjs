import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
const isWindows = process.platform === "win32";
const binaryName = isWindows ? "agent-relay.exe" : "agent-relay";
const outDir = path.resolve(packageRoot, "bin");
const outPath = path.resolve(outDir, binaryName);

function buildReleaseBinary() {
  const result = spawnSync("cargo", ["build", "--release", "--bin", "agent-relay"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error("failed to build release agent-relay binary");
  }
}

function ensureExecutable(filePath) {
  if (!isWindows) {
    fs.chmodSync(filePath, 0o755);
  }
}

function main() {
  let source = null;
  if (process.env.AGENT_RELAY_BIN) {
    source = path.resolve(process.env.AGENT_RELAY_BIN);
    if (!fs.existsSync(source)) {
      throw new Error(`AGENT_RELAY_BIN does not exist: ${source}`);
    }
  } else {
    buildReleaseBinary();
    source = path.resolve(repoRoot, "target", "release", binaryName);
  }

  if (!source || !fs.existsSync(source)) {
    throw new Error("agent-relay binary not found after build");
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(source, outPath);
  ensureExecutable(outPath);

  console.log(`bundled ${source} -> ${outPath}`);
}

main();
