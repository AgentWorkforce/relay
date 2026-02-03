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

# OPTION 1: Dashboard (recommended for interactive use)
# Open http://localhost:3888, click "Spawn Agent", enter name and CLI

# OPTION 2: Spawn command (for scripting/automation)
agent-relay spawn Alice claude "Help with coding tasks"
agent-relay spawn Bob claude "Wait for instructions"

# Release an agent
agent-relay release Alice

# ADVANCED: create-agent wraps CLI in tmux with messaging
# Use when you need shadow agents or other advanced options
agent-relay create-agent claude
agent-relay create-agent -n Worker claude
agent-relay create-agent -q -n Worker claude  # quiet mode

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
