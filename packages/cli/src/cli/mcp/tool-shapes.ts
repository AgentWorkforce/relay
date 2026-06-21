import { z } from 'zod';

/** Standard output schema for tools that return a single confirmation message. */
export const messageResult = {
  message: z.string().describe('Human-readable confirmation message'),
};

/**
 * Optional `as` input field that lets a tool act on behalf of one of several
 * registered agent identities in the same MCP session.
 */
export const identityOverrideInputShape = {
  as: z
    .string()
    .optional()
    .describe('Registered agent identity to act as when multiple identities have been registered'),
};
