# Changelog

All notable changes to Agent Relay will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

#### MCP Server Support
- New `@agent-relay/mcp` package providing Model Context Protocol (MCP) server
- One-command installation: `npx @agent-relay/mcp install`
- Support for Claude Desktop, Claude Code, Cursor, VS Code, Windsurf, and Zed
- 6 native tools for AI agents:
  - `relay_send` - Send messages to agents/channels
  - `relay_inbox` - Check pending messages
  - `relay_who` - List online agents
  - `relay_spawn` - Spawn worker agents
  - `relay_release` - Release workers
  - `relay_status` - Check connection status
- 3 MCP resources for state inspection:
  - `relay://agents` - List of online agents
  - `relay://inbox` - Message inbox
  - `relay://project` - Project configuration
- Automatic socket discovery with cloud workspace support
- Integration with main CLI via `agent-relay mcp` command
- Comprehensive test suite with 43 passing tests

### Changed
- Updated main CLI to include MCP commands via dynamic import

### Technical Details
- MCP server uses simplified RelayClient for minimal overhead
- Auto-discovery supports RELAY_SOCKET env, cloud workspaces, CWD config
- Editor configurations use JSONC format with proper comment preservation
- Package designed for global npm installation and npx usage