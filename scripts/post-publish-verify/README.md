# Post-Publish Verification

Automated tests to verify the `agent-relay` npm package works correctly after publishing.

## What It Tests

1. **Global npm install** (`npm install -g agent-relay`)
   - `--version` flag
   - `-V` flag
   - `version` command
   - `--help` flag

2. **npx execution** (`npx agent-relay`)
   - Version commands
   - Help output

3. **Local project install** (`npm install agent-relay`)
   - npx within project
   - Direct bin execution (`./node_modules/.bin/agent-relay`)

## Node.js Versions

Tests run across all supported Node.js versions:

- Node.js 18 (minimum supported)
- Node.js 20 (LTS)
- Node.js 22 (Current)

## Usage

### Local Testing (Docker)

```bash
# Test latest published version
./scripts/post-publish-verify/run-verify.sh

# Test specific version
./scripts/post-publish-verify/run-verify.sh 2.0.25

# Test in parallel (faster)
./scripts/post-publish-verify/run-verify.sh latest --parallel

# Test single Node.js version
./scripts/post-publish-verify/run-verify.sh latest --node 20
```

### Docker Compose Directly

```bash
cd scripts/post-publish-verify

# Test latest
docker compose up --build

# Test specific version
PACKAGE_VERSION=2.0.25 docker compose up --build

# Test single Node version
docker compose up --build node20

# Cleanup
docker compose down --rmi local
```

### GitHub Actions

The verification runs automatically after publishing via the `verify-publish.yml` workflow.

You can also trigger it manually:

1. Go to Actions tab
2. Select "Verify Published Package"
3. Click "Run workflow"
4. Optionally specify a version to test

## Files

- `Dockerfile` - Multi-stage Dockerfile supporting different Node versions
- `verify-install.sh` - Main verification script run inside containers
- `docker-compose.yml` - Orchestrates tests across Node versions
- `run-verify.sh` - Local runner script with nice output
- `.github/workflows/verify-publish.yml` - GitHub Actions workflow
