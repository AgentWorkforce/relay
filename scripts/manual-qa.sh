#!/bin/bash
#
# Agent Relay Cloud - Manual QA Testing Setup
#
# This script sets up everything for manual browser-based QA testing:
# - PostgreSQL and Redis (via Docker)
# - Cloud API server (local, with test mode)
# - Daemon simulators generating test data
# - Creates test user for dashboard access
#
# Usage:
#   ./scripts/manual-qa.sh              # Start everything
#   ./scripts/manual-qa.sh --stop       # Stop all services
#   ./scripts/manual-qa.sh --create-data # Create test data only
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_header() { echo -e "\n${CYAN}=== $1 ===${NC}\n"; }

# Parse arguments
STOP_ONLY=false
CREATE_DATA_ONLY=false

while [[ "$#" -gt 0 ]]; do
    case $1 in
        --stop) STOP_ONLY=true ;;
        --create-data) CREATE_DATA_ONLY=true ;;
        -h|--help)
            echo "Usage: $0 [options]"
            echo ""
            echo "Options:"
            echo "  --stop         Stop all services"
            echo "  --create-data  Create test data only (assumes services running)"
            echo "  -h, --help     Show this help"
            exit 0
            ;;
        *) log_error "Unknown option: $1"; exit 1 ;;
    esac
    shift
done

cd "$PROJECT_DIR"

# Stop services
stop_services() {
    log_header "Stopping Services"

    # Stop daemon simulators
    pkill -f "daemon-simulator" 2>/dev/null || true

    # Stop cloud server
    pkill -f "node dist/cloud/index.js" 2>/dev/null || true

    # Stop Docker services
    docker compose -f docker-compose.dev.yml down 2>/dev/null || true

    log_success "All services stopped"
}

if [ "$STOP_ONLY" = true ]; then
    stop_services
    exit 0
fi

# Create test data
create_test_data() {
    log_header "Creating Test Data"

    local API_URL="${1:-http://localhost:3000}"

    # Wait for API to be ready
    log_info "Waiting for API..."
    for i in {1..30}; do
        if curl -sf "$API_URL/health" >/dev/null 2>&1; then
            break
        fi
        if [ $i -eq 30 ]; then
            log_error "API not available"
            return 1
        fi
        sleep 1
    done

    # Create test user
    log_info "Creating test user..."
    USER_RESPONSE=$(curl -sf -X POST "$API_URL/api/test/create-user" \
        -H "Content-Type: application/json" \
        -d '{"email": "qa@test.local", "name": "QA Tester"}' 2>/dev/null || echo "")

    if [ -n "$USER_RESPONSE" ]; then
        USER_ID=$(echo "$USER_RESPONSE" | grep -o '"userId":"[^"]*"' | cut -d'"' -f4)
        log_success "Created test user: $USER_ID"
    else
        log_warn "Could not create test user (may already exist or test mode disabled)"
    fi

    # Create test daemons
    log_info "Creating test daemons..."

    for i in 1 2 3; do
        DAEMON_RESPONSE=$(curl -sf -X POST "$API_URL/api/test/create-daemon" \
            -H "Content-Type: application/json" \
            -d "{\"name\": \"qa-daemon-$i\", \"machineId\": \"qa-machine-$i\"}" 2>/dev/null || echo "")

        if [ -n "$DAEMON_RESPONSE" ]; then
            DAEMON_ID=$(echo "$DAEMON_RESPONSE" | grep -o '"daemonId":"[^"]*"' | cut -d'"' -f4)
            API_KEY=$(echo "$DAEMON_RESPONSE" | grep -o '"apiKey":"[^"]*"' | cut -d'"' -f4)
            log_success "Created daemon $i: $DAEMON_ID"

            # Save API key for simulator
            echo "$API_KEY" > "/tmp/qa-daemon-$i.key"
        fi
    done

    log_success "Test data created!"
}

if [ "$CREATE_DATA_ONLY" = true ]; then
    create_test_data
    exit 0
fi

# Main setup
log_header "Agent Relay - Manual QA Setup"

# Check prerequisites
if ! docker info >/dev/null 2>&1; then
    log_error "Docker is not running"
    exit 1
fi

if ! command -v node >/dev/null 2>&1; then
    log_error "Node.js is required"
    exit 1
fi

# Step 1: Build if needed
if [ ! -d "dist" ]; then
    log_header "Building Project"
    npm run build
fi

# Step 2: Start infrastructure
log_header "Starting Infrastructure"

docker compose -f docker-compose.dev.yml up -d postgres redis

log_info "Waiting for PostgreSQL..."
for i in {1..30}; do
    if docker compose -f docker-compose.dev.yml exec -T postgres pg_isready -U agent_relay >/dev/null 2>&1; then
        log_success "PostgreSQL is ready"
        break
    fi
    if [ $i -eq 30 ]; then
        log_error "PostgreSQL failed to start"
        exit 1
    fi
    sleep 1
done

log_info "Waiting for Redis..."
for i in {1..30}; do
    if docker compose -f docker-compose.dev.yml exec -T redis redis-cli ping >/dev/null 2>&1; then
        log_success "Redis is ready"
        break
    fi
    if [ $i -eq 30 ]; then
        log_error "Redis failed to start"
        exit 1
    fi
    sleep 1
done

# Step 3: Start Cloud API server
log_header "Starting Cloud API Server"

export NODE_ENV=development
export PORT=3000
export PUBLIC_URL=http://localhost:3000
export DATABASE_URL="postgres://agent_relay:dev_password@localhost:5432/agent_relay"
export REDIS_URL="redis://localhost:6379"
export SESSION_SECRET="dev-session-secret"
export VAULT_MASTER_KEY="ZGV2LXZhdWx0LWtleS1jaGFuZ2UtaW4tcHJvZHVjdGlvbg=="
export RELAY_CLOUD_ENABLED=true
export RELAY_MEMORY_MONITORING=true

# Start cloud server in background
node dist/cloud/index.js &
CLOUD_PID=$!
echo $CLOUD_PID > /tmp/cloud-server.pid

log_info "Cloud server starting (PID: $CLOUD_PID)..."

# Wait for cloud server
for i in {1..60}; do
    if curl -sf http://localhost:3000/health >/dev/null 2>&1; then
        log_success "Cloud API server is ready"
        break
    fi
    if [ $i -eq 60 ]; then
        log_error "Cloud server failed to start"
        exit 1
    fi
    sleep 1
done

# Step 4: Create test data
create_test_data "http://localhost:3000"

# Step 5: Start daemon simulators
log_header "Starting Daemon Simulators"

# Check if tsx is available, otherwise use ts-node or compile
if command -v tsx >/dev/null 2>&1; then
    TSX_CMD="tsx"
elif command -v ts-node >/dev/null 2>&1; then
    TSX_CMD="ts-node"
else
    log_warn "No TypeScript runner found, skipping simulators"
    TSX_CMD=""
fi

if [ -n "$TSX_CMD" ] && [ -f "test/cloud/daemon-simulator.ts" ]; then
    # Start simulator 1 - normal operation
    DAEMON_NAME=qa-daemon-1 \
    CLOUD_API_URL=http://localhost:3000 \
    AGENT_COUNT=3 \
    REPORT_INTERVAL_MS=5000 \
    SIMULATE_MEMORY_GROWTH=false \
    $TSX_CMD test/cloud/daemon-simulator.ts &
    echo $! > /tmp/simulator-1.pid
    log_info "Started simulator 1 (PID: $!)"

    # Start simulator 2 - memory growth
    DAEMON_NAME=qa-daemon-2 \
    CLOUD_API_URL=http://localhost:3000 \
    AGENT_COUNT=2 \
    REPORT_INTERVAL_MS=5000 \
    SIMULATE_MEMORY_GROWTH=true \
    $TSX_CMD test/cloud/daemon-simulator.ts &
    echo $! > /tmp/simulator-2.pid
    log_info "Started simulator 2 (PID: $!)"

    sleep 3
    log_success "Daemon simulators running"
else
    log_warn "Daemon simulators not started (tsx/ts-node not available)"
fi

# Done!
log_header "Manual QA Environment Ready!"

echo -e "${GREEN}Access Points:${NC}"
echo "  - Dashboard:  http://localhost:3000"
echo "  - API Health: http://localhost:3000/health"
echo "  - Metrics:    http://localhost:3000/metrics"
echo ""
echo -e "${GREEN}Test Endpoints:${NC}"
echo "  - GET  /api/test/status           - Check test mode"
echo "  - POST /api/test/create-user      - Create test user"
echo "  - POST /api/test/create-daemon    - Create test daemon"
echo ""
echo -e "${GREEN}Database Access:${NC}"
echo "  psql postgres://agent_relay:dev_password@localhost:5432/agent_relay"
echo ""
echo -e "${GREEN}Redis Access:${NC}"
echo "  redis-cli -h localhost -p 6379"
echo ""
echo -e "${YELLOW}Note:${NC} OAuth is bypassed in test mode. Use /api/test endpoints to create users."
echo ""
echo -e "To stop: ${CYAN}./scripts/manual-qa.sh --stop${NC}"
echo ""

# Keep script running to show logs
log_info "Showing cloud server logs (Ctrl+C to exit, services keep running)..."
echo ""
tail -f /dev/null
