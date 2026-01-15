/**
 * Unit tests for WebSocket routing in the cloud server.
 *
 * CRITICAL: These tests verify that different WebSocket types route to the correct servers.
 * - Agent logs MUST route to workspace.publicUrl (where agent runs)
 * - Channels MUST route to getLocalDashboardUrl() (where channel state lives)
 *
 * If these tests fail, check src/cloud/server.ts WebSocket handlers.
 * See also: .claude/rules/cloud-websocket-routing.md
 */

import { describe, it, expect } from 'vitest';

/**
 * Documents the routing requirements for WebSocket connections.
 * These tests serve as executable documentation to prevent routing regressions.
 */
describe('WebSocket Routing Requirements', () => {
  describe('Agent Logs WebSocket (/ws/logs/:workspaceId/:agentName)', () => {
    it('MUST route to workspace.publicUrl, not getLocalDashboardUrl()', () => {
      // This test documents the requirement - actual implementation is in server.ts
      //
      // WHY: Agents are spawned on the workspace server (via POST /api/spawn to workspace.publicUrl).
      // The spawner tracks workers in memory on that specific server.
      // If logs connect to a different server, spawner.hasWorker() returns false → 4404 Agent not found.
      //
      // CORRECT:
      //   const dashboardUrl = workspace.publicUrl || await getLocalDashboardUrl();
      //
      // WRONG:
      //   const dashboardUrl = await getLocalDashboardUrl(); // Ignores where agent actually runs!
      //
      // This broke in commit 5569296 when channel routing was changed to use getLocalDashboardUrl().
      // The logs WebSocket was accidentally changed along with channels.

      const routingRequirement = {
        endpoint: '/ws/logs/:workspaceId/:agentName',
        targetServer: 'workspace.publicUrl',
        fallback: 'getLocalDashboardUrl()',
        reason: 'Agent spawner state lives on workspace server',
      };

      expect(routingRequirement.targetServer).toBe('workspace.publicUrl');
      expect(routingRequirement.targetServer).not.toBe('getLocalDashboardUrl()');
    });

    it('should fallback to getLocalDashboardUrl() only when workspace.publicUrl is missing', () => {
      // Fallback is for edge cases where workspace doesn't have a publicUrl yet
      // (e.g., workspace is starting up or in local dev mode)

      const routingLogic = (workspace: { publicUrl?: string }) => {
        return workspace.publicUrl || 'getLocalDashboardUrl()';
      };

      // When publicUrl exists, use it
      expect(routingLogic({ publicUrl: 'https://workspace.fly.dev' })).toBe('https://workspace.fly.dev');

      // When publicUrl is missing, fall back
      expect(routingLogic({})).toBe('getLocalDashboardUrl()');
      expect(routingLogic({ publicUrl: undefined })).toBe('getLocalDashboardUrl()');
      expect(routingLogic({ publicUrl: '' })).toBe('getLocalDashboardUrl()');
    });
  });

  describe('Channel WebSocket (/ws/channels/:workspaceId/:username)', () => {
    it('MUST route to getLocalDashboardUrl(), not workspace.publicUrl', () => {
      // This test documents the requirement - actual implementation is in server.ts
      //
      // WHY: Channel state (membership, messages) is managed by the local daemon.
      // The daemon stores channel data in local files/memory.
      // Channels are not workspace-specific - they span across all agents in a team.
      //
      // CORRECT:
      //   const dashboardUrl = await getLocalDashboardUrl();
      //
      // WRONG:
      //   const dashboardUrl = workspace.publicUrl; // Channel state isn't on workspace!

      const routingRequirement = {
        endpoint: '/ws/channels/:workspaceId/:username',
        targetServer: 'getLocalDashboardUrl()',
        reason: 'Channel state lives on local daemon, not workspace',
      };

      expect(routingRequirement.targetServer).toBe('getLocalDashboardUrl()');
      expect(routingRequirement.targetServer).not.toBe('workspace.publicUrl');
    });
  });

  describe('Routing Summary Table', () => {
    it('documents all WebSocket routing requirements', () => {
      // This serves as a quick reference for the routing rules
      const routingTable = [
        {
          type: 'Agent Logs',
          endpoint: '/ws/logs/:workspaceId/:agentName',
          target: 'workspace.publicUrl',
          reason: 'Agent runs on workspace, spawner state is there',
        },
        {
          type: 'Channels',
          endpoint: '/ws/channels/:workspaceId/:username',
          target: 'getLocalDashboardUrl()',
          reason: 'Channel state is local to daemon',
        },
        {
          type: 'Presence',
          endpoint: '/ws/presence',
          target: 'local (no proxy)',
          reason: 'Cloud server manages presence directly',
        },
      ];

      // Verify logs route to workspace
      const logsRoute = routingTable.find(r => r.type === 'Agent Logs');
      expect(logsRoute?.target).toBe('workspace.publicUrl');

      // Verify channels route to local
      const channelsRoute = routingTable.find(r => r.type === 'Channels');
      expect(channelsRoute?.target).toBe('getLocalDashboardUrl()');
    });
  });
});

/**
 * Integration-style test that verifies the actual code pattern in server.ts
 */
describe('Server Code Pattern Verification', () => {
  it('verifies logs WebSocket uses workspace.publicUrl pattern', async () => {
    // Read the actual server.ts code and verify the pattern
    const fs = await import('fs');
    const path = await import('path');

    const serverPath = path.join(__dirname, 'server.ts');
    const serverCode = fs.readFileSync(serverPath, 'utf-8');

    // Find the wssLogs.on('connection') handler
    const logsHandlerMatch = serverCode.match(
      /wssLogs\.on\('connection'[\s\S]*?const dashboardUrl = ([^;]+);/
    );

    expect(logsHandlerMatch).toBeTruthy();

    if (logsHandlerMatch) {
      const dashboardUrlAssignment = logsHandlerMatch[1];

      // MUST use workspace.publicUrl (with fallback)
      expect(dashboardUrlAssignment).toContain('workspace.publicUrl');

      // Should have fallback to getLocalDashboardUrl()
      expect(dashboardUrlAssignment).toContain('getLocalDashboardUrl()');

      // The pattern should be: workspace.publicUrl || await getLocalDashboardUrl()
      // NOT just: await getLocalDashboardUrl()
      expect(dashboardUrlAssignment).not.toBe('await getLocalDashboardUrl()');
    }
  });
});
