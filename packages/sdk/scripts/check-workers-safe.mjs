/**
 * SDK Workers-safety probe.
 *
 * Prevents regressions of the Cloudflare Workers error 10021 class of bug,
 * where a transitive static import inside @agent-relay/sdk executes
 * Node-only code at module load (e.g. top-level createRequire(import.meta.url))
 * and crashes the bundle during Cloudflare's upload validation.
 *
 * Strategy: bundle a minimal consumer that does
 *
 *     import { AgentRelayClient, PROTOCOL_VERSION } from "@agent-relay/sdk";
 *
 * against this checkout of the SDK, with Workers-friendly esbuild conditions
 * (workerd, worker, browser, import). Because package.json has a "workerd"
 * export condition pointing at the narrow workers.js entry, the resolver
 * picks the narrow surface — NOT the Node-only root index.js. After
 * bundling, the probe imports the output in Node and invokes its default
 * fetch handler. Any module-init crash is caught and surfaced in <10 seconds.
 *
 * Runs in CI on every PR touching packages/sdk/** as a structural guarantee:
 * it is IMPOSSIBLE to ship an SDK where a Workers consumer's root import
 * transitively pulls Workers-incompatible code into their bundle, because
 * this probe will catch the regression pre-merge.
 *
 * Usage: node packages/sdk/scripts/check-workers-safe.mjs
 * Exit:  0 = SDK root import is Workers-safe
 *        1 = regression detected (bundle or module-init failure)
 */

import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptFile = fileURLToPath(import.meta.url);
const scriptsDir = dirname(scriptFile);
const sdkRoot = dirname(scriptsDir);
const monorepoRoot = dirname(dirname(sdkRoot));

const tmpDir = join(sdkRoot, "tmp", "workers-safe-probe");
const consumerPath = join(tmpDir, "consumer.mjs");
const outfile = join(tmpDir, "bundle.mjs");

mkdirSync(tmpDir, { recursive: true });

// Minimal Workers consumer. Imports are structured so the bundler cannot
// tree-shake them away — both symbols are referenced at runtime inside
// fetch(), so any regression in their static graph will land in the
// bundle.
writeFileSync(
  consumerPath,
  [
    'import { AgentRelayClient, PROTOCOL_VERSION } from "@agent-relay/sdk";',
    "",
    "export default {",
    "  async fetch(_req, _env, _ctx) {",
    "    const ping = {",
    "      protocol: PROTOCOL_VERSION,",
    '      client: typeof AgentRelayClient,',
    "    };",
    "    return new Response(JSON.stringify(ping), {",
    '      headers: { "content-type": "application/json" },',
    "    });",
    "  },",
    "};",
    "",
  ].join("\n"),
);

try {
  await build({
    entryPoints: [consumerPath],
    outfile,
    bundle: true,
    format: "esm",
    target: "es2022",
    // platform: 'node' auto-externalizes node built-ins (both "node:*" and
    // bare-name forms). In workerd they resolve via nodejs_compat; in this
    // probe they resolve via Node. Either way, the bundle just needs to
    // keep the import specifiers intact.
    platform: "node",
    mainFields: ["module", "main"],
    // The critical part: "workerd" MUST come first. With the SDK's new
    // package.json, this resolves the root specifier to the narrow
    // workers.js entry that skips workflows/collectors/etc.
    conditions: ["workerd", "worker", "browser", "import"],
    nodePaths: [
      join(monorepoRoot, "node_modules"),
      join(sdkRoot, "node_modules"),
    ],
    // CJS->ESM wrapper needs a runtime require for transitive CJS deps
    // that call require('util') etc. workerd+nodejs_compat provides one;
    // in the probe we synthesize it via createRequire.
    banner: {
      js: "import { createRequire as __sdkProbeCreateRequire } from 'node:module'; const require = __sdkProbeCreateRequire(import.meta.url);",
    },
    logLevel: "error",
    logOverride: { "empty-import-meta": "silent" },
  });
} catch (err) {
  console.error("FAIL: esbuild could not bundle a Workers consumer of @agent-relay/sdk");
  console.error(err?.stack ?? String(err));
  process.exit(1);
}

let mod;
try {
  mod = await import(pathToFileURL(outfile).href);
} catch (err) {
  console.error("FAIL: SDK root import crashes at module init under Workers conditions");
  console.error(
    "This is the shape of Cloudflare Workers error 10021 — some module in the",
  );
  console.error(
    "static graph of @agent-relay/sdk (via the 'workerd' export condition)",
  );
  console.error(
    "executes Node-only code at module load. Fix by making that code lazy,",
  );
  console.error(
    "or by narrowing the workerd entry (packages/sdk/src/workers.ts) so it",
  );
  console.error("does not pull the offender.");
  console.error("");
  console.error(err?.stack ?? String(err));
  process.exit(1);
}

try {
  if (typeof mod.default?.fetch !== "function") {
    throw new Error("consumer bundle is missing default export with a fetch method");
  }
  const req = new Request("http://probe.local/ping");
  const res = await mod.default.fetch(req, {}, {
    waitUntil: () => {},
    passThroughOnException: () => {},
  });
  if (res.status !== 200) {
    throw new Error(`consumer /ping returned HTTP ${res.status}`);
  }
  const body = await res.json();
  if (body?.client !== "function") {
    throw new Error(
      `consumer /ping expected AgentRelayClient to be a function, got ${JSON.stringify(body)}`,
    );
  }
} catch (err) {
  console.error("FAIL: SDK workerd entry is reachable but the handler misbehaved");
  console.error(err?.stack ?? String(err));
  process.exit(1);
}

console.log("OK: @agent-relay/sdk workerd entry is Workers-safe");

