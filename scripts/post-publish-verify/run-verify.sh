#!/bin/bash
# Post-publish verification runner
#
# Tests agent-relay npm package across multiple Node.js versions using Docker
#
# Usage:
#   ./run-verify.sh                    # Test latest version
#   ./run-verify.sh 2.0.25             # Test specific version
#   ./run-verify.sh latest --parallel  # Run all versions in parallel
#   ./run-verify.sh 2.0.25 --node 22   # Test specific Node.js version only

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[PASS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[FAIL]${NC} $1"; }
log_header() { echo -e "\n${BLUE}════════════════════════════════════════${NC}"; echo -e "${BLUE}  $1${NC}"; echo -e "${BLUE}════════════════════════════════════════${NC}\n"; }

# Parse arguments
PACKAGE_VERSION="${1:-latest}"
PARALLEL=false
SPECIFIC_NODE=""
FAILED_VERSIONS=()

shift || true
while [[ $# -gt 0 ]]; do
    case $1 in
        --parallel|-p)
            PARALLEL=true
            shift
            ;;
        --node|-n)
            SPECIFIC_NODE="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: $0 [VERSION] [OPTIONS]"
            echo ""
            echo "Arguments:"
            echo "  VERSION          Package version to test (default: latest)"
            echo ""
            echo "Options:"
            echo "  --parallel, -p   Run all Node versions in parallel"
            echo "  --node, -n VER   Test only specific Node.js version (22 or 24)"
            echo "  --help, -h       Show this help"
            echo ""
            echo "Examples:"
            echo "  $0                     # Test latest across all Node versions"
            echo "  $0 2.0.25              # Test version 2.0.25"
            echo "  $0 latest --parallel   # Test in parallel"
            echo "  $0 2.0.25 --node 22    # Test only Node 22"
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            exit 1
            ;;
    esac
done

if [ -n "$SPECIFIC_NODE" ] && [ "$SPECIFIC_NODE" != "22" ] && [ "$SPECIFIC_NODE" != "24" ]; then
    log_error "Unsupported Node.js version: $SPECIFIC_NODE (supported: 22, 24)"
    exit 1
fi

log_header "Agent Relay Post-Publish Verification"
log_info "Package version: $PACKAGE_VERSION"
log_info "Parallel mode: $PARALLEL"
if [ -n "$SPECIFIC_NODE" ]; then
    log_info "Testing Node.js version: $SPECIFIC_NODE only"
fi

# Export for docker-compose
export PACKAGE_VERSION

# Determine which services to run
if [ -n "$SPECIFIC_NODE" ]; then
    SERVICES="node${SPECIFIC_NODE}"
else
    SERVICES="node22 node24"
fi

# Build images
log_info "Building Docker images..."
docker compose build $SERVICES

# Run tests
if [ "$PARALLEL" = true ]; then
    log_info "Running verification in parallel..."
    docker compose up --abort-on-container-exit $SERVICES
    EXIT_CODE=$?
else
    # Run sequentially to see output clearly
    for service in $SERVICES; do
        log_header "Testing $service"
        if docker compose up --abort-on-container-exit "$service"; then
            log_success "$service verification passed"
        else
            log_error "$service verification failed"
            FAILED_VERSIONS+=("$service")
        fi
        # Clean up container
        docker compose rm -f "$service" 2>/dev/null || true
    done
fi

# Cleanup
log_info "Cleaning up..."
docker compose down --rmi local 2>/dev/null || true

# Summary
log_header "Verification Complete"
log_info "Package version tested: $PACKAGE_VERSION"

if [ ${#FAILED_VERSIONS[@]} -eq 0 ]; then
    log_success "All Node.js versions passed verification!"
    exit 0
else
    log_error "Failed versions: ${FAILED_VERSIONS[*]}"
    exit 1
fi
