#!/bin/bash
set -euo pipefail

# Produce the single-file input used by Bun's standalone compiler.  Bun's
# native bundler cannot relocate the Relayfile SDK's package-json lookup when
# that package is pulled through RelayFlows; esbuild inlines the dependency
# and the version is already supplied by the CLI build.

INPUT="${1:?usage: $0 <entrypoint> <output> <version>}"
OUTPUT="${2:?usage: $0 <entrypoint> <output> <version>}"
VERSION="${3:?usage: $0 <entrypoint> <output> <version>}"

# npm's esbuild install script may replace bin/esbuild with the platform
# native executable on Linux, while macOS retains the Node shebang wrapper.
# Execute that package bin directly so both layouts choose their own launcher;
# passing it through Bun or Node would parse a Linux ELF as JavaScript.
node_modules/esbuild/bin/esbuild "$INPUT" \
  --bundle \
  --platform=node \
  --target=node18 \
  --format=esm \
  --outfile="$OUTPUT" \
  --external:better-sqlite3 \
  --external:cpu-features \
  --external:node-pty \
  --external:e2b \
  --external:modal \
  --external:freestyle \
  --external:microsandbox \
  --external:@vercel/sandbox \
  --external:@aws-sdk/client-bedrock-agentcore-control \
  --external:@aws-sdk/client-bedrock-agentcore \
  --define:process.env.AGENT_RELAY_VERSION="\"$VERSION\""

# @relayfile/sdk reads its own package.json through createRequire.  In a
# compiled Bun image that relative CJS lookup has no package directory, so
# preserve the package version as a build-time constant instead.
if ! grep -Eq 'String\(require[0-9]+\("\.\./package\.json"\)\.version\)' "$OUTPUT"; then
  echo "bundle is missing the Relayfile version lookup" >&2
  exit 1
fi
RELAYFILE_VERSION="$(bun -e 'console.log(require("./node_modules/@relayfile/sdk/package.json").version)')" perl -0pi -e \
  's/String\(require\d+\("\.\.\/package\.json"\)\.version\)/"$ENV{RELAYFILE_VERSION}"/' \
  "$OUTPUT"

if grep -Eq 'String\(require[0-9]+\("\.\.\/package\.json"\)\.version\)' "$OUTPUT"; then
  echo "failed to inline the Relayfile version" >&2
  exit 1
fi
