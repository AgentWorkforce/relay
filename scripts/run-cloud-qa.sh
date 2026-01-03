#!/bin/bash
#
# Agent Relay Cloud - Full QA Test Runner
#
# This script runs the complete cloud QA test suite locally using Docker.
# It simulates the production environment with:
# - PostgreSQL database
# - Redis for sessions/pub-sub
# - Cloud API server
# - Simulated daemons reporting metrics
# - Integration tests
#
# Usage:
#   ./scripts/run-cloud-qa.sh              # Run all tests
#   ./scripts/run-cloud-qa.sh --quick      # Quick smoke test
#   ./scripts/run-cloud-qa.sh --cleanup    # Cleanup only
#   ./scripts/run-cloud-qa.sh --logs       # Show logs after tests
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.test.yml"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Parse arguments
QUICK_MODE=false
CLEANUP_ONLY=false
SHOW_LOGS=false
KEEP_RUNNING=false

while [[ "$#" -gt 0 ]]; do
    case $1 in
        --quick) QUICK_MODE=true ;;
        --cleanup) CLEANUP_ONLY=true ;;
        --logs) SHOW_LOGS=true ;;
        --keep) KEEP_RUNNING=true ;;
        -h|--help)
            echo "Usage: $0 [options]"
            echo ""
            echo "Options:"
            echo "  --quick     Run quick smoke test only"
            echo "  --cleanup   Cleanup test containers and volumes"
            echo "  --logs      Show container logs after tests"
            echo "  --keep      Keep containers running after tests"
            echo "  -h, --help  Show this help message"
            exit 0
            ;;
        *) log_error "Unknown option: $1"; exit 1 ;;
    esac
    shift
done

# Cleanup function
cleanup() {
    log_info "Cleaning up test environment..."
    docker compose -f "$COMPOSE_FILE" down -v --remove-orphans 2>/dev/null || true
    log_success "Cleanup complete"
}

# Handle SIGINT/SIGTERM
trap cleanup EXIT

# Cleanup only mode
if [ "$CLEANUP_ONLY" = true ]; then
    cleanup
    exit 0
fi

# Check Docker is running
if ! docker info >/dev/null 2>&1; then
    log_error "Docker is not running. Please start Docker and try again."
    exit 1
fi

# Check docker-compose file exists
if [ ! -f "$COMPOSE_FILE" ]; then
    log_error "docker-compose.test.yml not found at: $COMPOSE_FILE"
    exit 1
fi

log_info "=========================================="
log_info "Agent Relay Cloud - QA Test Suite"
log_info "=========================================="
echo ""

# Step 1: Build images
log_info "Step 1: Building Docker images..."
docker compose -f "$COMPOSE_FILE" build --quiet

# Step 2: Start infrastructure (PostgreSQL, Redis)
log_info "Step 2: Starting infrastructure..."
docker compose -f "$COMPOSE_FILE" up -d postgres redis

# Wait for services to be healthy
log_info "Waiting for PostgreSQL and Redis..."
for i in {1..30}; do
    if docker compose -f "$COMPOSE_FILE" ps postgres | grep -q "healthy" && \
       docker compose -f "$COMPOSE_FILE" ps redis | grep -q "healthy"; then
        log_success "Infrastructure is ready"
        break
    fi
    if [ $i -eq 30 ]; then
        log_error "Infrastructure failed to become healthy"
        docker compose -f "$COMPOSE_FILE" logs postgres redis
        exit 1
    fi
    sleep 1
done

# Step 3: Start cloud server
log_info "Step 3: Starting Cloud API server..."
docker compose -f "$COMPOSE_FILE" up -d cloud

# Wait for cloud server
log_info "Waiting for Cloud API server..."
for i in {1..60}; do
    if curl -sf http://localhost:3100/health >/dev/null 2>&1; then
        log_success "Cloud API server is ready"
        break
    fi
    if [ $i -eq 60 ]; then
        log_error "Cloud API server failed to start"
        docker compose -f "$COMPOSE_FILE" logs cloud
        exit 1
    fi
    sleep 1
done

# Step 4: Start daemon simulators
log_info "Step 4: Starting daemon simulators..."
docker compose -f "$COMPOSE_FILE" up -d daemon-simulator-1 daemon-simulator-2

# Give simulators time to connect and report metrics
log_info "Waiting for simulators to connect..."
sleep 10

if [ "$QUICK_MODE" = true ]; then
    # Quick smoke test
    log_info "Running quick smoke test..."

    # Test health endpoint
    if curl -sf http://localhost:3100/health >/dev/null; then
        log_success "Health check passed"
    else
        log_error "Health check failed"
        exit 1
    fi

    # Test API is responding
    if curl -sf http://localhost:3100/api/test/status >/dev/null; then
        log_success "Test API responding"
    else
        log_warn "Test API not available (may be in production mode)"
    fi

    log_success "Quick smoke test passed!"
else
    # Step 5: Run integration tests
    log_info "Step 5: Running integration tests..."

    # Run the test runner container
    docker compose -f "$COMPOSE_FILE" --profile test run --rm test-runner
    TEST_EXIT_CODE=$?

    if [ $TEST_EXIT_CODE -eq 0 ]; then
        log_success "All integration tests passed!"
    else
        log_error "Integration tests failed with exit code: $TEST_EXIT_CODE"
    fi
fi

# Show logs if requested
if [ "$SHOW_LOGS" = true ]; then
    log_info "Container logs:"
    echo ""
    docker compose -f "$COMPOSE_FILE" logs --tail=100
fi

# Keep running if requested
if [ "$KEEP_RUNNING" = true ]; then
    log_info "Containers are still running. Press Ctrl+C to stop."
    log_info "Cloud API: http://localhost:3100"
    log_info "PostgreSQL: localhost:5433"
    log_info "Redis: localhost:6380"
    # Disable cleanup trap
    trap - EXIT
    # Wait forever
    while true; do sleep 3600; done
else
    log_info "Cleaning up..."
fi

echo ""
log_info "=========================================="
log_info "QA Test Suite Complete"
log_info "=========================================="
