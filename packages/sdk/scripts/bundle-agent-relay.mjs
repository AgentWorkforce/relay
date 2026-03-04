import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
const isWindows = process.platform === "win32";
const binaryName = isWindows ? "agent-relay-broker.exe" : "agent-relay-broker";
const outDir = path.resolve(packageRoot, "bin");

// Use platform-specific name so the SDK only picks up binaries matching the
// current OS/arch.  This prevents e.g. a macOS binary from being used on Linux.
const platformSuffixes = {
  darwin: { arm64: "darwin-arm64", x64: "darwin-x64" },
  linux: { arm64: "linux-arm64", x64: "linux-x64" },
  win32: { x64: "win32-x64" },
};
const suffix = platformSuffixes[process.platform]?.[process.arch];
const outName = suffix ? `agent-relay-broker-${suffix}${isWindows ? '.exe' : ''}` : binaryName;
const outPath = path.resolve(outDir, outName);

function buildReleaseBinary() {
  const result = spawnSync("cargo", ["build", "--release", "--bin", "agent-relay-broker"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error("failed to build release agent-relay-broker binary");
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
    throw new Error("agent-relay-broker binary not found after build");
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(source, outPath);
  ensureExecutable(outPath);

  console.log(`bundled ${source} -> ${outPath}`);
}

main();
