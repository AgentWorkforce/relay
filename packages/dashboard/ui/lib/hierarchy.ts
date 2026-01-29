/**
 * Agent Hierarchy Utilities
 *
 * Helpers for parsing, displaying, and organizing agents
 * based on their hierarchical naming convention.
 */

import type { Agent } from '../types';
import { getAgentPrefix, getAgentColor, type ColorScheme } from './colors';

export interface HierarchyNode {
  name: string;
  level: number;
  fullPath: string;
  children: HierarchyNode[];
  agent?: Agent;
  color: ColorScheme;
}

export interface AgentGroup {
  prefix: string;
  displayName: string;
  color: ColorScheme;
  agents: Agent[];
  isExpanded: boolean;
}

/**
 * Build a tree structure from a list of agents
 * e.g., ["backend-api", "backend-db", "frontend-ui"]
 * becomes a tree with "backend" and "frontend" as roots
 */
export function buildAgentTree(agents: Agent[]): HierarchyNode[] {
  const roots: Map<string, HierarchyNode> = new Map();

  for (const agent of agents) {
    const parts = agent.name.toLowerCase().split('-').filter(Boolean);
    if (parts.length === 0) continue;

    const prefix = parts[0];
    const color = getAgentColor(agent.name);

    // Get or create root node
    let root = roots.get(prefix);
    if (!root) {
      root = {
        name: prefix,
        level: 0,
        fullPath: prefix,
        children: [],
        color,
      };
      roots.set(prefix, root);
    }

    // For single-segment names, attach agent to root
    if (parts.length === 1) {
      root.agent = agent;
      continue;
    }

    // Build path for multi-segment names
    let current = root;
    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      const fullPath = parts.slice(0, i + 1).join('-');

      let child = current.children.find((c) => c.name === part);
      if (!child) {
        child = {
          name: part,
          level: i,
          fullPath,
          children: [],
          color,
        };
        current.children.push(child);
      }

      // Attach agent to leaf node
      if (i === parts.length - 1) {
        child.agent = agent;
      }

      current = child;
    }
  }

  // Sort roots alphabetically
  return Array.from(roots.values()).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
}

/**
 * Flatten a hierarchy tree for list display
 * Returns nodes in depth-first order with indentation level
 */
export function flattenTree(
  nodes: HierarchyNode[],
  depth = 0
): Array<{ node: HierarchyNode; depth: number }> {
  const result: Array<{ node: HierarchyNode; depth: number }> = [];

  for (const node of nodes) {
    result.push({ node, depth });

    if (node.children.length > 0) {
      result.push(...flattenTree(node.children, depth + 1));
    }
  }

  return result;
}

/**
 * Group agents by their team (if set) or prefix for simpler grouped display.
 * User-defined teams take priority over auto-extracted prefixes.
 */
export function groupAgents(agents: Agent[]): AgentGroup[] {
  const groups: Map<string, AgentGroup> = new Map();

  for (const agent of agents) {
    // Use team if set, otherwise fall back to prefix from name
    const groupKey = agent.team || getAgentPrefix(agent.name);
    const color = getAgentColor(agent.name);

    let group = groups.get(groupKey);
    if (!group) {
      group = {
        prefix: groupKey,
        displayName: capitalizeFirst(groupKey),
        color,
        agents: [],
        isExpanded: true,
      };
      groups.set(groupKey, group);
    }

    group.agents.push(agent);
  }

  // Sort groups and agents within groups
  const sortedGroups = Array.from(groups.values()).sort((a, b) =>
    a.prefix.localeCompare(b.prefix)
  );

  for (const group of sortedGroups) {
    group.agents.sort((a, b) => a.name.localeCompare(b.name));
  }

  return sortedGroups;
}

/**
 * Get display name for an agent (last segment, capitalized)
 * e.g., "backend-api-auth" => "Auth"
 */
export function getAgentDisplayName(name: string): string {
  const parts = name.split('-').filter(Boolean);
  if (parts.length === 0) return name;

  const lastPart = parts[parts.length - 1];
  return capitalizeFirst(lastPart);
}

/**
 * Get full display path for an agent
 * e.g., "backend-api-auth" => "Backend > API > Auth"
 */
export function getAgentBreadcrumb(name: string): string {
  const parts = name.split('-').filter(Boolean);
  return parts.map(capitalizeFirst).join(' > ');
}

/**
 * Check if an agent name matches a search query
 * Matches against all hierarchy segments
 */
export function matchesSearch(agentName: string, query: string): boolean {
  if (!query) return true;

  const lowerQuery = query.toLowerCase();
  const lowerName = agentName.toLowerCase();

  // Direct match
  if (lowerName.includes(lowerQuery)) return true;

  // Match any segment
  const parts = lowerName.split('-');
  return parts.some((part) => part.includes(lowerQuery));
}

/**
 * Filter agents by search query
 */
export function filterAgents(agents: Agent[], query: string): Agent[] {
  if (!query) return agents;
  return agents.filter((agent) => matchesSearch(agent.name, query));
}

/**
 * Sort agents by their hierarchical name for consistent display
 */
export function sortAgentsByHierarchy(agents: Agent[]): Agent[] {
  return [...agents].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Capitalize first letter of a string
 */
function capitalizeFirst(str: string): string {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Get statistics for a group of agents
 */
export function getGroupStats(agents: Agent[]): {
  total: number;
  online: number;
  offline: number;
  needsAttention: number;
} {
  let online = 0;
  let offline = 0;
  let needsAttention = 0;

  for (const agent of agents) {
    if (agent.status === 'online') online++;
    else if (agent.status === 'offline') offline++;
    if (agent.needsAttention) needsAttention++;
  }

  return {
    total: agents.length,
    online,
    offline,
    needsAttention,
  };
}
