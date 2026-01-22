/**
 * Prompt Composer
 *
 * Dynamically composes role-specific prompts for agents based on their profile.
 * Loads prompts from .claude/agents/roles/ and injects them into agent context.
 *
 * Part of agent-relay-512: Role-specific prompts
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Agent role types that have specific prompts
 */
export type AgentRole = 'planner' | 'worker' | 'reviewer' | 'lead' | 'shadow';

/**
 * Agent profile with role information
 */
export interface AgentProfile {
  /** Agent name */
  name: string;
  /** Agent role */
  role?: AgentRole;
  /** Custom prompt overrides */
  customPrompt?: string;
  /** Whether this is a sub-planner */
  isSubPlanner?: boolean;
  /** Parent agent name (for hierarchical context) */
  parentAgent?: string;
}

/**
 * Composed prompt result
 */
export interface ComposedPrompt {
  /** The full composed prompt */
  content: string;
  /** Role prompt that was used (if any) */
  rolePrompt?: string;
  /** Custom additions */
  customAdditions?: string;
}

/**
 * Prompt cache to avoid repeated file reads
 */
const promptCache: Map<string, string> = new Map();

/**
 * Clear the prompt cache (useful for testing or hot-reload)
 */
export function clearPromptCache(): void {
  promptCache.clear();
}

/**
 * Map role to prompt file name
 */
function getRolePromptFile(role: AgentRole): string {
  switch (role) {
    case 'planner':
    case 'lead':
      return 'planner-strategy.md';
    case 'worker':
      return 'worker-focus.md';
    case 'reviewer':
    case 'shadow':
      return 'reviewer-criteria.md';
    default:
      return '';
  }
}

/**
 * Load a prompt file from the prompts directory
 */
async function loadPromptFile(
  projectRoot: string,
  filename: string
): Promise<string | undefined> {
  // Check cache first
  const cacheKey = `${projectRoot}:${filename}`;
  if (promptCache.has(cacheKey)) {
    return promptCache.get(cacheKey);
  }

  const promptPath = path.join(projectRoot, '.claude', 'agents', 'roles', filename);

  try {
    const content = await fs.readFile(promptPath, 'utf-8');
    promptCache.set(cacheKey, content);
    return content;
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      console.warn(`[prompt-composer] Failed to load ${filename}:`, err.message);
    }
    return undefined;
  }
}

/**
 * Compose a prompt for an agent based on their profile
 *
 * @param profile - Agent profile with role information
 * @param projectRoot - Project root directory for finding prompt files
 * @param context - Optional additional context to include
 * @returns Composed prompt with role-specific instructions
 */
export async function composeForAgent(
  profile: AgentProfile,
  projectRoot: string,
  context?: {
    taskDescription?: string;
    parentContext?: string;
    teamMembers?: string[];
  }
): Promise<ComposedPrompt> {
  const parts: string[] = [];
  let rolePrompt: string | undefined;

  // Load role-specific prompt if role is defined
  if (profile.role) {
    const promptFile = getRolePromptFile(profile.role);
    if (promptFile) {
      rolePrompt = await loadPromptFile(projectRoot, promptFile);
      if (rolePrompt) {
        parts.push(rolePrompt);
      }
    }
  }

  // Add hierarchical context for sub-planners or workers
  if (profile.parentAgent) {
    parts.push(`
## Team Context

You are working under **${profile.parentAgent}**.
Report your progress and blockers to them.
`);
  }

  // Add task context if provided
  if (context?.taskDescription) {
    parts.push(`
## Your Current Task

${context.taskDescription}
`);
  }

  // Add team awareness if provided
  if (context?.teamMembers && context.teamMembers.length > 0) {
    parts.push(`
## Team Members

Other agents you can communicate with:
${context.teamMembers.map(m => `- ${m}`).join('\n')}
`);
  }

  // Add custom prompt if provided
  if (profile.customPrompt) {
    parts.push(`
## Additional Instructions

${profile.customPrompt}
`);
  }

  return {
    content: parts.join('\n\n---\n\n'),
    rolePrompt,
    customAdditions: profile.customPrompt,
  };
}

/**
 * Get available role prompts in the project
 */
export async function getAvailableRoles(projectRoot: string): Promise<AgentRole[]> {
  const rolesDir = path.join(projectRoot, '.claude', 'agents', 'roles');
  const available: AgentRole[] = [];

  try {
    const files = await fs.readdir(rolesDir);

    if (files.includes('planner-strategy.md')) {
      available.push('planner', 'lead');
    }
    if (files.includes('worker-focus.md')) {
      available.push('worker');
    }
    if (files.includes('reviewer-criteria.md')) {
      available.push('reviewer', 'shadow');
    }
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      console.warn('[prompt-composer] Failed to list roles:', err.message);
    }
  }

  return available;
}

/**
 * Parse role from agent profile frontmatter
 *
 * @param profileContent - Raw agent profile markdown content
 * @returns Parsed role or undefined
 */
export function parseRoleFromProfile(profileContent: string): AgentRole | undefined {
  // Look for role: in frontmatter
  const frontmatterMatch = profileContent.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) {
    return undefined;
  }

  const frontmatter = frontmatterMatch[1];
  const roleMatch = frontmatter.match(/^role:\s*(\w+)/m);

  if (roleMatch) {
    const role = roleMatch[1].toLowerCase();
    if (['planner', 'worker', 'reviewer', 'lead', 'shadow'].includes(role)) {
      return role as AgentRole;
    }
  }

  return undefined;
}
