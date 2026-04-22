# PLAN — Agent Relay CLI Commands TDD Tests

## Goal
Test all agent-relay CLI commands in headless mode (spawn, who, agents:logs, release, set-model, send, history, inbox) to verify they work and fix failures.

## Commands to Test
- spawn, who, agents:logs, release, set-model, send, history, inbox

## Known Issues
- history requires RELAY_API_KEY (broken in local-only mode)
- send has sender identity issues
- inbox fails without RELAY_API_KEY