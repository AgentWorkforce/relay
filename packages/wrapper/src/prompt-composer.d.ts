/**
 * Prompt Composer
 *
 * Dynamically composes role-specific prompts for agents based on their profile.
 * Loads prompts from .claude/agents/roles/ and injects them into agent context.
 *
 * Part of agent-relay-512: Role-specific prompts
 */
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
 * Clear the prompt cache (useful for testing or hot-reload)
 */
export declare function clearPromptCache(): void;
/**
 * Compose a prompt for an agent based on their profile
 *
 * @param profile - Agent profile with role information
 * @param projectRoot - Project root directory for finding prompt files
 * @param context - Optional additional context to include
 * @returns Composed prompt with role-specific instructions
 */
export declare function composeForAgent(profile: AgentProfile, projectRoot: string, context?: {
    taskDescription?: string;
    parentContext?: string;
    teamMembers?: string[];
}): Promise<ComposedPrompt>;
/**
 * Get available role prompts in the project
 */
export declare function getAvailableRoles(projectRoot: string): Promise<AgentRole[]>;
/**
 * Parse role from agent profile frontmatter
 *
 * @param profileContent - Raw agent profile markdown content
 * @returns Parsed role or undefined
 */
export declare function parseRoleFromProfile(profileContent: string): AgentRole | undefined;
//# sourceMappingURL=prompt-composer.d.ts.map