#!/bin/bash
# Agent Relay CLI Usage Examples
# These are example commands - don't run this file directly

# ============================================
# Starting the Daemon
# ============================================

# Start daemon only (dashboard disabled by default)
agent-relay up

# Start daemon with web dashboard enabled
agent-relay up --dashboard

# Start daemon with dashboard on custom port
agent-relay up --dashboard --port 4000

# Check if daemon is running
agent-relay status

# Stop the daemon
agent-relay down

# ============================================
# Running Agents
# ============================================

# Wrap any command with agent-relay using create-agent
agent-relay create-agent claude

# Specify a custom agent name
agent-relay create-agent -n Alice claude

# Wrap with quiet mode (less output)
agent-relay create-agent -q -n Bob claude

# Spawn a new agent via the daemon
agent-relay spawn Worker claude "Help with coding tasks"

# Release an agent
agent-relay release Worker

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
