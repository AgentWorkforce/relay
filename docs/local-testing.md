# Agent Relay Cloud - Local Testing Guide

This guide explains how to run the complete Agent Relay Cloud stack locally for development and QA testing.

## Overview

The local testing environment simulates the full cloud deployment with:
- **PostgreSQL** - Database for users, workspaces, metrics, crashes
- **Redis** - Session storage and pub/sub messaging
- **Cloud API Server** - Express.js control plane
- **Daemon Simulators** - Simulated local daemons reporting metrics
- **Integration Tests** - Comprehensive API tests

## Prerequisites

1. **Docker** (version 20.10+)
2. **Docker Compose** (v2.0+)
3. **Node.js** (v20+) - for running tests locally
4. **Git** - for cloning the repository

### Verify Prerequisites

```bash
docker --version          # Should be 20.10+
docker compose version    # Should be 2.0+
node --version           # Should be v20+
```

## Quick Start

### Option 1: Full QA Suite (Recommended)

Run the complete test suite with a single command:

```bash
./scripts/run-cloud-qa.sh
```

This will:
1. Build all Docker images
2. Start PostgreSQL and Redis
3. Start the Cloud API server
4. Start simulated daemons
5. Run integration tests
6. Clean up all containers

### Option 2: Manual Setup

For development and debugging, you may want to run components separately.

#### Step 1: Start Infrastructure

```bash
# Start PostgreSQL and Redis
docker compose -f docker-compose.test.yml up -d postgres redis

# Verify they're healthy
docker compose -f docker-compose.test.yml ps
```

#### Step 2: Start Cloud Server

```bash
# Start the cloud API server
docker compose -f docker-compose.test.yml up -d cloud

# Check logs
docker compose -f docker-compose.test.yml logs -f cloud

# Verify it's running
curl http://localhost:3100/health
```

#### Step 3: Start Daemon Simulators

```bash
# Start simulated daemons that report metrics
docker compose -f docker-compose.test.yml up -d daemon-simulator-1 daemon-simulator-2

# View simulator logs
docker compose -f docker-compose.test.yml logs -f daemon-simulator-1
```

#### Step 4: Run Tests

```bash
# Run integration tests in Docker
docker compose -f docker-compose.test.yml --profile test run test-runner

# Or run locally
CLOUD_API_URL=http://localhost:3100 npm run test:integration
```

## Docker Compose Services

### docker-compose.test.yml

| Service | Port | Description |
|---------|------|-------------|
| `postgres` | 5433 | PostgreSQL database |
| `redis` | 6380 | Redis for sessions/pub-sub |
| `cloud` | 3100 | Cloud API server |
| `daemon-simulator-1` | - | Simulated daemon (3 agents, memory growth) |
| `daemon-simulator-2` | - | Simulated daemon (2 agents, normal) |
| `daemon-simulator-crash` | - | Crash simulation daemon (profile: crash-test) |
| `test-runner` | - | Integration test runner (profile: test) |

### docker-compose.dev.yml

For regular development (not testing):

| Service | Port | Description |
|---------|------|-------------|
| `postgres` | 5432 | PostgreSQL database |
| `redis` | 6379 | Redis |
| `cloud` | 3000 | Cloud API + Dashboard |
| `workspace` | 3888, 3889 | Example workspace (profile: workspace) |

## Test Modes

### Quick Smoke Test

Fast validation that the stack is working:

```bash
./scripts/run-cloud-qa.sh --quick
```

### Full Integration Tests

Complete test suite with all scenarios:

```bash
./scripts/run-cloud-qa.sh
```

### Keep Running After Tests

Useful for debugging:

```bash
./scripts/run-cloud-qa.sh --keep
```

Then access:
- Cloud API: http://localhost:3100
- Health check: http://localhost:3100/health
- Test status: http://localhost:3100/api/test/status

### Show Logs

View container logs after tests:

```bash
./scripts/run-cloud-qa.sh --logs
```

## Test Infrastructure

### Daemon Simulator

Located in `test/cloud/daemon-simulator.ts`, this simulates local daemons that:
- Connect to the cloud API
- Report agent memory metrics
- Report crashes (configurable)
- Report memory alerts

Configuration via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `DAEMON_NAME` | test-daemon | Name of the daemon |
| `CLOUD_API_URL` | http://localhost:3000 | Cloud API URL |
| `AGENT_COUNT` | 3 | Number of agents to simulate |
| `REPORT_INTERVAL_MS` | 10000 | Metrics report interval |
| `SIMULATE_MEMORY_GROWTH` | false | Simulate memory leak |
| `SIMULATE_CRASH` | false | Trigger crash after delay |
| `CRASH_AFTER_SECONDS` | 60 | Delay before crash |

### Test Helpers API

In non-production mode, these endpoints are available:

```bash
# Check if test mode is enabled
GET /api/test/status

# Create a test user (bypasses OAuth)
POST /api/test/create-user
Body: { "email": "test@example.com", "name": "Test User" }

# Create a test daemon with API key
POST /api/test/create-daemon
Body: { "name": "my-daemon", "machineId": "optional-machine-id" }

# Cleanup test data
DELETE /api/test/cleanup
```

### Integration Tests

Located in `test/cloud/monitoring.integration.test.ts`:

- Health check validation
- Metrics reporting (authenticated/unauthenticated)
- Crash reporting
- Alert reporting
- Dashboard API authentication
- Multiple daemon scenarios
- Alert escalation
- Crash pattern detection

## Running Tests Locally

### Unit Tests (Fast)

```bash
# All unit tests
npm test

# Specific module
npm test -- src/resiliency/

# Watch mode
npm test -- --watch
```

### Integration Tests

```bash
# Start the stack first
docker compose -f docker-compose.test.yml up -d postgres redis cloud

# Run integration tests
CLOUD_API_URL=http://localhost:3100 npm run test:integration

# Or with Docker
docker compose -f docker-compose.test.yml --profile test run test-runner
```

### Coverage Report

```bash
npm run test:coverage
```

## Development Workflow

### Making Changes

1. Make code changes
2. Run unit tests: `npm test`
3. Start test stack: `docker compose -f docker-compose.test.yml up -d`
4. Run integration tests: `npm run test:integration`
5. Cleanup: `docker compose -f docker-compose.test.yml down -v`

### Debugging Cloud Server

```bash
# Start with logs
docker compose -f docker-compose.test.yml up cloud

# Or attach to running container
docker compose -f docker-compose.test.yml logs -f cloud

# Shell into container
docker compose -f docker-compose.test.yml exec cloud sh
```

### Database Access

```bash
# Connect to PostgreSQL
docker compose -f docker-compose.test.yml exec postgres psql -U agent_relay -d agent_relay_test

# View tables
\dt

# Query metrics
SELECT * FROM agent_metrics ORDER BY recorded_at DESC LIMIT 10;

# Query crashes
SELECT * FROM agent_crashes ORDER BY crashed_at DESC LIMIT 10;
```

### Redis Access

```bash
# Connect to Redis
docker compose -f docker-compose.test.yml exec redis redis-cli

# View keys
KEYS *

# Monitor pub/sub
SUBSCRIBE coordinator:messages
```

## Troubleshooting

### Container Won't Start

```bash
# Check logs
docker compose -f docker-compose.test.yml logs <service-name>

# Rebuild images
docker compose -f docker-compose.test.yml build --no-cache

# Remove volumes and restart
docker compose -f docker-compose.test.yml down -v
docker compose -f docker-compose.test.yml up -d
```

### Database Connection Issues

```bash
# Verify PostgreSQL is healthy
docker compose -f docker-compose.test.yml ps postgres

# Check connection from cloud container
docker compose -f docker-compose.test.yml exec cloud sh
> nc -zv postgres 5432
```

### Port Conflicts

If ports are already in use:

```bash
# Find what's using the port
lsof -i :3100

# Or change ports in docker-compose.test.yml
```

### Memory Issues

Docker may run out of memory with many containers:

```bash
# Check Docker resource usage
docker stats

# Prune unused resources
docker system prune -a

# Increase Docker memory limit in Docker Desktop settings
```

## CI/CD Integration

### GitHub Actions

The test suite runs in GitHub Actions. See `.github/workflows/test.yml`:

```yaml
- name: Run Integration Tests
  run: |
    docker compose -f docker-compose.test.yml up -d postgres redis cloud
    sleep 30
    CLOUD_API_URL=http://localhost:3100 npm run test:integration
```

### Local CI Simulation

```bash
# Simulate CI environment
./scripts/run-cloud-qa.sh
```

## Adding New Tests

### Unit Tests

1. Create `*.test.ts` file alongside the source
2. Use Vitest patterns (describe, it, expect)
3. Mock external dependencies

### Integration Tests

1. Add tests to `test/cloud/monitoring.integration.test.ts`
2. Use the test helper API for setup
3. Clean up test data in afterAll

### New Simulator Scenarios

1. Add new service to `docker-compose.test.yml`
2. Configure via environment variables
3. Use appropriate profile if optional

## Reference

### Environment Variables

**Cloud Server:**
- `NODE_ENV` - development/test/production
- `DATABASE_URL` - PostgreSQL connection string
- `REDIS_URL` - Redis connection string
- `SESSION_SECRET` - Session encryption key
- `RELAY_CLOUD_ENABLED` - Enable cloud features
- `RELAY_MEMORY_MONITORING` - Enable memory monitoring

**Test:**
- `CLOUD_API_URL` - Cloud server URL for tests
- `TEST_TIMEOUT` - Test timeout in milliseconds

### Useful Commands

```bash
# Full QA suite
./scripts/run-cloud-qa.sh

# Quick test
./scripts/run-cloud-qa.sh --quick

# Keep running
./scripts/run-cloud-qa.sh --keep

# Cleanup only
./scripts/run-cloud-qa.sh --cleanup

# View all containers
docker compose -f docker-compose.test.yml ps

# Stop everything
docker compose -f docker-compose.test.yml down -v
```
