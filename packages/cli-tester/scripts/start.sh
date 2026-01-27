#!/bin/bash
# Start the CLI tester Docker environment
# Usage: ./start.sh [--clean] [--build] [--daemon]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(dirname "$SCRIPT_DIR")"
DOCKER_DIR="$PACKAGE_DIR/docker"

# Parse arguments
CLEAN=false
BUILD=false
WITH_DAEMON=false
while [[ $# -gt 0 ]]; do
    case $1 in
        --clean)
            CLEAN=true
            shift
            ;;
        --build)
            BUILD=true
            shift
            ;;
        --daemon)
            WITH_DAEMON=true
            shift
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: ./start.sh [--clean] [--build] [--daemon]"
            echo "  --clean   Remove credential volumes before starting"
            echo "  --build   Force rebuild of Docker image"
            echo "  --daemon  Start with relay daemon for full integration testing"
            exit 1
            ;;
    esac
done

cd "$DOCKER_DIR"

# Clean volumes if requested
if [ "$CLEAN" = true ]; then
    echo "Removing credential volumes..."
    docker compose down -v 2>/dev/null || true
fi

# Build compose args
COMPOSE_ARGS=()
if [ "$WITH_DAEMON" = true ]; then
    COMPOSE_ARGS+=(--profile daemon)
fi

# Build if requested or if image doesn't exist
if [ "$BUILD" = true ]; then
    echo "Building Docker image..."
    docker compose "${COMPOSE_ARGS[@]}" build
fi

# Start the container interactively
echo ""
if [ "$WITH_DAEMON" = true ]; then
    echo "Starting CLI tester environment with daemon..."
    echo "The daemon will be available at http://daemon:3377"
else
    echo "Starting CLI tester environment..."
fi
echo "Use Ctrl+D or 'exit' to leave the container."
echo ""

docker compose "${COMPOSE_ARGS[@]}" run --rm cli-tester
