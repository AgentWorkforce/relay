#!/bin/bash
# Agent Relay CLI Usage Examples
# These are example commands - don't run this file directly

# ============================================
# Starting the Daemon
# ============================================

# Start daemon with default settings (port 3888)
agent-relay up

# Start daemon on custom port
agent-relay up --port 4000

# Start daemon without web dashboard
agent-relay up --no-dashboard

# Check if daemon is running
agent-relay status

# Stop the daemon
agent-relay down

# ============================================
# Running Agents
# ============================================

# Wrap any command with agent-relay
agent-relay claude

# Specify a custom agent name
agent-relay -n Alice claude

# Wrap with quiet mode (less output)
agent-relay -q -n Bob claude

# Custom relay prefix (default: ->relay:)
agent-relay --prefix ">>msg:" -n Charlie claude

# ============================================
# Message Management
# ============================================

# List connected agents
agent-relay agents

# Show active agents (alias)
agent-relay who

# Read a truncated message by ID
agent-relay read abc12345

# View message history
agent-relay history

# View history with filters
agent-relay history --since 1h        # Last hour
agent-relay history --since 30m       # Last 30 minutes
agent-relay history --limit 50        # Last 50 messages
agent-relay history --from Alice      # Messages from Alice
agent-relay history --to Bob          # Messages to Bob

# ============================================
# Multiple Projects
# ============================================

# Each project gets isolated data based on project root
# Just run agent-relay from different project directories

cd /path/to/project-a
agent-relay up                        # Uses ~/.agent-relay/<hash-of-project-a>/

cd /path/to/project-b
agent-relay up                        # Uses ~/.agent-relay/<hash-of-project-b>/

# List all known projects
agent-relay projects
