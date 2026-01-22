/**
 * Auth Revocation Detection
 *
 * Detects when an AI CLI's authentication has been revoked.
 * This can happen when:
 * 1. User authenticates the same provider elsewhere (limited sessions)
 * 2. Token expires or is invalidated
 * 3. OAuth refresh fails
 */
/**
 * Patterns that indicate authentication has been revoked or expired.
 * These are typically output by Claude CLI, Codex, etc. when auth fails.
 */
export declare const AUTH_REVOCATION_PATTERNS: RegExp[];
/**
 * Patterns that should NOT trigger auth revocation detection.
 * These are false positives that might match auth patterns but aren't actual auth errors.
 */
export declare const AUTH_FALSE_POSITIVE_PATTERNS: RegExp[];
export interface AuthRevocationResult {
    detected: boolean;
    pattern?: string;
    confidence: 'high' | 'medium' | 'low';
    message?: string;
}
/**
 * Detect if output indicates authentication has been revoked.
 *
 * @param output - The CLI output to analyze
 * @param recentOutputOnly - If true, only check the last ~500 chars (for real-time detection)
 * @returns Detection result with confidence level
 */
export declare function detectAuthRevocation(output: string, recentOutputOnly?: boolean): AuthRevocationResult;
/**
 * Check if the given text looks like an auth-related CLI prompt
 * that's waiting for user action (not an error, but a request to auth).
 */
export declare function isAuthPrompt(text: string): boolean;
/**
 * Provider-specific auth detection configuration.
 * Different AI CLIs may have different error messages.
 */
export declare const PROVIDER_AUTH_PATTERNS: Record<string, RegExp[]>;
/**
 * Detect auth revocation for a specific provider.
 * Uses provider-specific patterns in addition to general patterns.
 */
export declare function detectProviderAuthRevocation(output: string, provider: string): AuthRevocationResult;
//# sourceMappingURL=auth-detection.d.ts.map