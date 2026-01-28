/**
 * useOrchestrator Hook
 *
 * Connects to the daemon orchestrator for workspace and agent management.
 * Provides real-time updates via WebSocket.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { Workspace } from '../WorkspaceSelector';

export interface OrchestratorAgent {
  id: string;
  name: string;
  workspaceId: string;
  provider: string;
  status: 'running' | 'idle' | 'crashed' | 'restarting' | 'stopped';
  pid?: number;
  task?: string;
  spawnedAt: Date;
  restartCount: number;
}

export interface OrchestratorEvent {
  type: string;
  workspaceId?: string;
  agentId?: string;
  data: unknown;
  timestamp: Date;
}

export interface UseOrchestratorOptions {
  /** Orchestrator API URL (default: http://localhost:3456) */
  apiUrl?: string;
  /** Enable orchestrator connection (default: false - orchestrator is optional) */
  enabled?: boolean;
}

export interface UseOrchestratorResult {
  /** All workspaces */
  workspaces: Workspace[];
  /** Currently active workspace ID */
  activeWorkspaceId?: string;
  /** Active workspace agents */
  agents: OrchestratorAgent[];
  /** Connection status */
  isConnected: boolean;
  /** Loading state */
  isLoading: boolean;
  /** Error state */
  error: Error | null;
  /** Switch to a workspace */
  switchWorkspace: (workspaceId: string) => Promise<void>;
  /** Add a new workspace */
  addWorkspace: (path: string, name?: string) => Promise<Workspace>;
  /** Remove a workspace */
  removeWorkspace: (workspaceId: string) => Promise<void>;
  /** Spawn an agent */
  spawnAgent: (name: string, task?: string, provider?: string) => Promise<OrchestratorAgent>;
  /** Stop an agent */
  stopAgent: (agentName: string) => Promise<void>;
  /** Refresh data */
  refresh: () => Promise<void>;
}

export function useOrchestrator(options: UseOrchestratorOptions = {}): UseOrchestratorResult {
  const { apiUrl = 'http://localhost:3456', enabled = false } = options;

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>();
  const [agents, setAgents] = useState<OrchestratorAgent[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<Error | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  // Convert API URL to WebSocket URL
  const wsUrl = apiUrl.replace(/^http/, 'ws');

  // Fetch initial data - only if enabled
  const fetchData = useCallback(async () => {
    if (!enabled) {
      return;
    }

    try {
      setIsLoading(true);
      setError(null);

      const response = await fetch(`${apiUrl}/workspaces`);
      if (!response.ok) {
        throw new Error(`Failed to fetch workspaces: ${response.statusText}`);
      }

      const data = await response.json();
      setWorkspaces(
        data.workspaces.map((w: Workspace) => ({
          ...w,
          lastActiveAt: new Date(w.lastActiveAt),
        }))
      );
      setActiveWorkspaceId(data.activeWorkspaceId);

      // Fetch agents for active workspace
      if (data.activeWorkspaceId) {
        const agentsResponse = await fetch(`${apiUrl}/workspaces/${data.activeWorkspaceId}/agents`);
        if (agentsResponse.ok) {
          const agentsData = await agentsResponse.json();
          setAgents(
            agentsData.agents.map((a: OrchestratorAgent) => ({
              ...a,
              spawnedAt: new Date(a.spawnedAt),
            }))
          );
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, [apiUrl, enabled]);

  // WebSocket connection - only connect if enabled
  useEffect(() => {
    // Skip connection if orchestrator is not enabled
    if (!enabled) {
      return;
    }

    const connect = () => {
      try {
        const ws = new WebSocket(wsUrl);

        ws.onopen = () => {
          setIsConnected(true);
          setError(null);
        };

        ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data);

            if (message.type === 'init') {
              // Initial state from server
              setWorkspaces(
                message.data.workspaces.map((w: Workspace) => ({
                  ...w,
                  lastActiveAt: new Date(w.lastActiveAt),
                }))
              );
              setActiveWorkspaceId(message.data.activeWorkspaceId);
              setAgents(
                message.data.agents?.map((a: OrchestratorAgent) => ({
                  ...a,
                  spawnedAt: new Date(a.spawnedAt),
                })) || []
              );
              setIsLoading(false);
            } else if (message.type === 'event') {
              handleEvent(message.data as OrchestratorEvent);
            }
          } catch (err) {
            console.error('Failed to parse WebSocket message:', err);
          }
        };

        ws.onclose = () => {
          setIsConnected(false);
          wsRef.current = null;

          // Reconnect after delay
          reconnectTimeoutRef.current = setTimeout(connect, 3000);
        };

        ws.onerror = (err) => {
          console.error('WebSocket error:', err);
          ws.close();
        };

        wsRef.current = ws;
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
        // Retry connection
        reconnectTimeoutRef.current = setTimeout(connect, 3000);
      }
    };

    // Start with HTTP fetch, then upgrade to WebSocket
    fetchData().then(connect);

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [wsUrl, fetchData, enabled]);

  // Handle real-time events
  const handleEvent = useCallback((event: OrchestratorEvent) => {
    switch (event.type) {
      case 'workspace:added':
        setWorkspaces((prev) => [...prev, event.data as Workspace]);
        break;

      case 'workspace:removed':
        setWorkspaces((prev) => prev.filter((w) => w.id !== event.workspaceId));
        break;

      case 'workspace:updated':
        setWorkspaces((prev) =>
          prev.map((w) =>
            w.id === event.workspaceId ? { ...w, ...(event.data as Partial<Workspace>) } : w
          )
        );
        break;

      case 'workspace:switched':
        setActiveWorkspaceId((event.data as { currentId: string }).currentId);
        break;

      case 'agent:spawned':
        setAgents((prev) => [...prev, event.data as OrchestratorAgent]);
        break;

      case 'agent:stopped':
      case 'agent:crashed':
        setAgents((prev) => prev.filter((a) => a.name !== (event.data as { name: string }).name));
        break;

      case 'agent:restarted':
        setAgents((prev) =>
          prev.map((a) =>
            a.name === (event.data as { name: string }).name
              ? { ...a, status: 'running' as const, restartCount: a.restartCount + 1 }
              : a
          )
        );
        break;
    }
  }, []);

  // Switch workspace
  const switchWorkspace = useCallback(
    async (workspaceId: string) => {
      const response = await fetch(`${apiUrl}/workspaces/${workspaceId}/switch`, {
        method: 'POST',
      });

      if (!response.ok) {
        throw new Error(`Failed to switch workspace: ${response.statusText}`);
      }

      // Fetch agents for new workspace
      const agentsResponse = await fetch(`${apiUrl}/workspaces/${workspaceId}/agents`);
      if (agentsResponse.ok) {
        const agentsData = await agentsResponse.json();
        setAgents(
          agentsData.agents.map((a: OrchestratorAgent) => ({
            ...a,
            spawnedAt: new Date(a.spawnedAt),
          }))
        );
      }
    },
    [apiUrl]
  );

  // Add workspace
  const addWorkspace = useCallback(
    async (path: string, name?: string): Promise<Workspace> => {
      const response = await fetch(`${apiUrl}/workspaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, name }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to add workspace');
      }

      return response.json();
    },
    [apiUrl]
  );

  // Remove workspace
  const removeWorkspace = useCallback(
    async (workspaceId: string) => {
      const response = await fetch(`${apiUrl}/workspaces/${workspaceId}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error(`Failed to remove workspace: ${response.statusText}`);
      }
    },
    [apiUrl]
  );

  // Spawn agent
  const spawnAgent = useCallback(
    async (name: string, task?: string, provider?: string): Promise<OrchestratorAgent> => {
      if (!activeWorkspaceId) {
        throw new Error('No active workspace');
      }

      const response = await fetch(`${apiUrl}/workspaces/${activeWorkspaceId}/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, task, provider }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to spawn agent');
      }

      return response.json();
    },
    [apiUrl, activeWorkspaceId]
  );

  // Stop agent
  const stopAgent = useCallback(
    async (agentName: string) => {
      if (!activeWorkspaceId) {
        throw new Error('No active workspace');
      }

      const response = await fetch(
        `${apiUrl}/workspaces/${activeWorkspaceId}/agents/${agentName}`,
        {
          method: 'DELETE',
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to stop agent: ${response.statusText}`);
      }
    },
    [apiUrl, activeWorkspaceId]
  );

  return {
    workspaces,
    activeWorkspaceId,
    agents,
    isConnected,
    isLoading,
    error,
    switchWorkspace,
    addWorkspace,
    removeWorkspace,
    spawnAgent,
    stopAgent,
    refresh: fetchData,
  };
}
