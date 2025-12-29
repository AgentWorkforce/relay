/**
 * Hierarchical Color Coding System
 *
 * Inspired by AI Maestro's naming convention:
 * - Agent names use hyphens to denote hierarchy: project-category-agent
 * - Each top-level prefix gets a consistent color
 * - Colors are visually distinct and accessible
 */

export interface ColorScheme {
  primary: string;
  light: string;
  dark: string;
  text: string;
}

// Predefined color schemes for common agent prefixes
const PREFIX_COLORS: Record<string, ColorScheme> = {
  backend: {
    primary: '#1264a3',
    light: '#e8f4fd',
    dark: '#0d4f82',
    text: '#ffffff',
  },
  frontend: {
    primary: '#7c3aed',
    light: '#f3e8ff',
    dark: '#5b21b6',
    text: '#ffffff',
  },
  infra: {
    primary: '#ea580c',
    light: '#fff7ed',
    dark: '#c2410c',
    text: '#ffffff',
  },
  lead: {
    primary: '#2bac76',
    light: '#ecfdf5',
    dark: '#059669',
    text: '#ffffff',
  },
  test: {
    primary: '#0d9488',
    light: '#f0fdfa',
    dark: '#0f766e',
    text: '#ffffff',
  },
  data: {
    primary: '#dc2626',
    light: '#fef2f2',
    dark: '#b91c1c',
    text: '#ffffff',
  },
  api: {
    primary: '#2563eb',
    light: '#eff6ff',
    dark: '#1d4ed8',
    text: '#ffffff',
  },
  worker: {
    primary: '#9333ea',
    light: '#faf5ff',
    dark: '#7e22ce',
    text: '#ffffff',
  },
  monitor: {
    primary: '#0891b2',
    light: '#ecfeff',
    dark: '#0e7490',
    text: '#ffffff',
  },
  security: {
    primary: '#be123c',
    light: '#fff1f2',
    dark: '#9f1239',
    text: '#ffffff',
  },
};

// Fallback colors for unknown prefixes (generated from name hash)
const FALLBACK_COLORS: ColorScheme[] = [
  { primary: '#6366f1', light: '#eef2ff', dark: '#4f46e5', text: '#ffffff' },
  { primary: '#ec4899', light: '#fdf2f8', dark: '#db2777', text: '#ffffff' },
  { primary: '#14b8a6', light: '#f0fdfa', dark: '#0d9488', text: '#ffffff' },
  { primary: '#f59e0b', light: '#fffbeb', dark: '#d97706', text: '#000000' },
  { primary: '#8b5cf6', light: '#f5f3ff', dark: '#7c3aed', text: '#ffffff' },
  { primary: '#06b6d4', light: '#ecfeff', dark: '#0891b2', text: '#ffffff' },
  { primary: '#f43f5e', light: '#fff1f2', dark: '#e11d48', text: '#ffffff' },
  { primary: '#84cc16', light: '#f7fee7', dark: '#65a30d', text: '#000000' },
];

// Status colors
export const STATUS_COLORS = {
  online: '#22c55e',      // Green
  offline: '#6b7280',     // Gray
  busy: '#eab308',        // Yellow
  processing: '#6366f1',  // Indigo (thinking/processing)
  error: '#ef4444',       // Red
  attention: '#ef4444',   // Red (for badge)
} as const;

export type AgentStatus = keyof typeof STATUS_COLORS;

/**
 * Parse agent name into hierarchy levels
 * e.g., "backend-api-auth" => ["backend", "api", "auth"]
 */
export function parseAgentHierarchy(name: string): string[] {
  return name.toLowerCase().split('-').filter(Boolean);
}

/**
 * Get the top-level prefix from an agent name
 * e.g., "backend-api-auth" => "backend"
 */
export function getAgentPrefix(name: string): string {
  const parts = parseAgentHierarchy(name);
  return parts[0] || name.toLowerCase();
}

/**
 * Generate a hash code from a string for consistent color assignment
 */
function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash);
}

/**
 * Get color scheme for an agent based on its name
 * Uses prefix matching first, falls back to hash-based color
 */
export function getAgentColor(name: string): ColorScheme {
  const prefix = getAgentPrefix(name);

  // Check for predefined prefix color
  if (prefix in PREFIX_COLORS) {
    return PREFIX_COLORS[prefix];
  }

  // Fall back to hash-based color for consistency
  const hash = hashCode(prefix);
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length];
}

/**
 * Get CSS custom properties for an agent's color scheme
 * Useful for inline styles or CSS variables
 */
export function getAgentColorVars(name: string): Record<string, string> {
  const colors = getAgentColor(name);
  return {
    '--agent-primary': colors.primary,
    '--agent-light': colors.light,
    '--agent-dark': colors.dark,
    '--agent-text': colors.text,
  };
}

/**
 * Get initials from agent name (first 2 chars of first segment)
 */
export function getAgentInitials(name: string): string {
  const parts = parseAgentHierarchy(name);
  if (parts.length === 0) return name.substring(0, 2).toUpperCase();

  // Use first letter of first two segments, or first two letters of first segment
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return parts[0].substring(0, 2).toUpperCase();
}

/**
 * Group agents by their top-level prefix
 */
export function groupAgentsByPrefix<T extends { name: string }>(
  agents: T[]
): Map<string, T[]> {
  const groups = new Map<string, T[]>();

  for (const agent of agents) {
    const prefix = getAgentPrefix(agent.name);
    const group = groups.get(prefix) || [];
    group.push(agent);
    groups.set(prefix, group);
  }

  return groups;
}

/**
 * Sort agents by hierarchy for display
 * Groups by prefix, then sorts alphabetically within groups
 */
export function sortAgentsByHierarchy<T extends { name: string }>(
  agents: T[]
): T[] {
  return [...agents].sort((a, b) => {
    const prefixA = getAgentPrefix(a.name);
    const prefixB = getAgentPrefix(b.name);

    // Sort by prefix first
    if (prefixA !== prefixB) {
      return prefixA.localeCompare(prefixB);
    }

    // Then by full name
    return a.name.localeCompare(b.name);
  });
}
