#!/bin/bash
# Cloud local development setup script
# Usage: ./scripts/cloud-setup.sh [--skip-docker] [--skip-migrate] [--skip-data]

set -e

SKIP_DOCKER=false
SKIP_MIGRATE=false
SKIP_DATA=false

# Parse arguments
for arg in "$@"; do
  case $arg in
    --skip-docker) SKIP_DOCKER=true ;;
    --skip-migrate) SKIP_MIGRATE=true ;;
    --skip-data) SKIP_DATA=true ;;
  esac
done

echo "🚀 Setting up Agent Relay Cloud (local dev)"
echo ""

# Step 1: Start Docker services
if [ "$SKIP_DOCKER" = false ]; then
  echo "📦 Starting Docker services (Postgres + Redis)..."
  docker compose -f docker-compose.dev.yml up -d postgres redis

  # Wait for Postgres to be ready
  echo "⏳ Waiting for Postgres to be ready..."
  until docker compose -f docker-compose.dev.yml exec -T postgres pg_isready -U postgres > /dev/null 2>&1; do
    sleep 1
  done
  echo "✓ Postgres is ready"
else
  echo "⏭️  Skipping Docker setup"
fi

# Step 2: Build TypeScript
echo ""
echo "🔨 Building TypeScript..."
npm run build > /dev/null 2>&1
echo "✓ Build complete"

# Step 3: Run migrations
if [ "$SKIP_MIGRATE" = false ]; then
  echo ""
  echo "📊 Running database migrations..."
  npm run db:migrate 2>&1 | grep -E "(Applied|already applied|Error)" || true
  echo "✓ Migrations complete"
else
  echo "⏭️  Skipping migrations"
fi

# Step 4: Set up test data (only if server is running)
if [ "$SKIP_DATA" = false ]; then
  echo ""
  echo "🧪 Setting up test data..."

  # Check if cloud server is running, if not start it temporarily
  if ! curl -s http://localhost:4567/api/health > /dev/null 2>&1; then
    echo "   Starting cloud server temporarily for setup..."
    node dist/cloud/index.js &
    SERVER_PID=$!
    sleep 3
    STARTED_SERVER=true
  fi

  # Create test data
  RESPONSE=$(curl -s -X POST http://localhost:4567/api/test/setup-local-cloud \
    -H "Content-Type: application/json" \
    -c /tmp/relay-cookies.txt \
    -d '{"repoName": "test-org/test-repo", "workspaceName": "Local Dev"}' 2>&1 || echo '{"error": "Failed to connect"}')

  if echo "$RESPONSE" | grep -q '"success":true'; then
    echo "✓ Test data created"
    echo "   Cookie saved to /tmp/relay-cookies.txt"
  else
    echo "⚠️  Could not create test data (server may need to be running)"
  fi

  # Stop temp server if we started it
  if [ "$STARTED_SERVER" = true ]; then
    kill $SERVER_PID 2>/dev/null || true
  fi
else
  echo "⏭️  Skipping test data setup"
fi

echo ""
echo "✅ Setup complete!"
echo ""
echo "To start the cloud server:"
echo "  npm run cloud"
echo ""
echo "Then open: http://localhost:4567/app"
echo ""
