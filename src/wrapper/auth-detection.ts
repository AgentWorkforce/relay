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
export const AUTH_REVOCATION_PATTERNS: RegExp[] = [
  // Session/token expiration
  /session\s+(has\s+)?expired/i,
  /token\s+(has\s+)?expired/i,
  /credentials?\s+(have\s+)?expired/i,

  // Login required
  /please\s+log\s*in\s+again/i,
  /login\s+required/i,
  /authentication\s+required/i,
  /must\s+(be\s+)?log(ged)?\s*in/i,
  /you\s+need\s+to\s+log\s*in/i,

  // Unauthorized
  /\bunauthorized\b/i,
  /not\s+authorized/i,
  /access\s+denied/i,

  // Invalid credentials
  /invalid\s+credentials?/i,
  /invalid\s+token/i,
  /invalid\s+session/i,
  /not\s+authenticated/i,

  // OAuth specific
  /oauth\s+error.*401/i,
  /oauth\s+error.*403/i,
  /refresh\s+token\s+(is\s+)?invalid/i,
  /failed\s+to\s+refresh/i,

  // API errors that indicate auth issues
  /api\s+error.*401/i,
  /api\s+error.*403/i,
  /http\s+401/i,
  /http\s+403/i,

  // Claude-specific patterns
  /your\s+api\s+key\s+is\s+invalid/i,
  /api\s+key\s+not\s+found/i,
  /signed\s+out/i,
  /session\s+revoked/i,
];

/**
 * Patterns that should NOT trigger auth revocation detection.
 * These are false positives that might match auth patterns but aren't actual auth errors.
 */
export const AUTH_FALSE_POSITIVE_PATTERNS: RegExp[] = [
  // Documentation or help text
  /how\s+to\s+log\s*in/i,
  /login\s+instructions/i,
  /authentication\s+guide/i,

  // Code comments or strings
  /\/\/.*unauthorized/i,
  /\/\*.*unauthorized.*\*\//i,
  /".*unauthorized.*"/i,
  /'.*unauthorized.*'/i,

  // Error handling code
  /catch.*unauthorized/i,
  /handle.*auth.*error/i,
  /if.*session.*expired/i,

  // Instructional content
  /you\s+should\s+log\s*in/i,
  /make\s+sure\s+you('re)?\s+logged\s*in/i,
];

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
export function detectAuthRevocation(
  output: string,
  recentOutputOnly = false
): AuthRevocationResult {
  // If checking recent output only, truncate to last 500 chars
  const textToCheck = recentOutputOnly ? output.slice(-500) : output;

  // First check for false positives
  for (const falsePositive of AUTH_FALSE_POSITIVE_PATTERNS) {
    if (falsePositive.test(textToCheck)) {
      return { detected: false, confidence: 'low' };
    }
  }

  // Check each auth revocation pattern
  for (const pattern of AUTH_REVOCATION_PATTERNS) {
    const match = textToCheck.match(pattern);
    if (match) {
      // Determine confidence based on pattern specificity
      const confidence = getConfidenceLevel(pattern, match[0]);

      return {
        detected: true,
        pattern: pattern.source,
        confidence,
        message: match[0],
      };
    }
  }

  return { detected: false, confidence: 'low' };
}

/**
 * Determine confidence level based on the matched pattern.
 */
function getConfidenceLevel(
  pattern: RegExp,
  matchedText: string
): 'high' | 'medium' | 'low' {
  const patternStr = pattern.source.toLowerCase();

  // High confidence: Explicit auth failure messages
  if (
    patternStr.includes('session') && patternStr.includes('expired') ||
    patternStr.includes('please') && patternStr.includes('log') ||
    patternStr.includes('authentication required') ||
    patternStr.includes('token') && patternStr.includes('expired') ||
    patternStr.includes('signed out') ||
    patternStr.includes('session revoked')
  ) {
    return 'high';
  }

  // Medium confidence: General auth errors
  if (
    patternStr.includes('unauthorized') ||
    patternStr.includes('401') ||
    patternStr.includes('403') ||
    patternStr.includes('invalid') && patternStr.includes('credentials')
  ) {
    return 'medium';
  }

  // Low confidence: Could be related to other errors
  return 'low';
}

/**
 * Check if the given text looks like an auth-related CLI prompt
 * that's waiting for user action (not an error, but a request to auth).
 */
export function isAuthPrompt(text: string): boolean {
  const authPromptPatterns = [
    /open\s+this\s+url/i,
    /visit\s+.*to\s+authorize/i,
    /enter\s+your\s+api\s+key/i,
    /paste\s+your\s+token/i,
    /waiting\s+for\s+authorization/i,
    /complete\s+login\s+in\s+browser/i,
  ];

  return authPromptPatterns.some(pattern => pattern.test(text));
}

/**
 * Provider-specific auth detection configuration.
 * Different AI CLIs may have different error messages.
 */
export const PROVIDER_AUTH_PATTERNS: Record<string, RegExp[]> = {
  claude: [
    /claude.*session.*expired/i,
    /anthropic.*unauthorized/i,
    /claude.*not\s+authenticated/i,
    /please\s+run\s+claude\s+login/i,
  ],
  codex: [
    /codex.*session.*expired/i,
    /openai.*unauthorized/i,
    /codex.*not\s+authenticated/i,
  ],
  gemini: [
    /gemini.*session.*expired/i,
    /google.*unauthorized/i,
    /gemini.*not\s+authenticated/i,
  ],
};

/**
 * Detect auth revocation for a specific provider.
 * Uses provider-specific patterns in addition to general patterns.
 */
export function detectProviderAuthRevocation(
  output: string,
  provider: string
): AuthRevocationResult {
  // First check general patterns
  const generalResult = detectAuthRevocation(output, true);
  if (generalResult.detected && generalResult.confidence === 'high') {
    return generalResult;
  }

  // Check provider-specific patterns
  const providerPatterns = PROVIDER_AUTH_PATTERNS[provider.toLowerCase()];
  if (providerPatterns) {
    for (const pattern of providerPatterns) {
      const match = output.match(pattern);
      if (match) {
        return {
          detected: true,
          pattern: pattern.source,
          confidence: 'high',
          message: match[0],
        };
      }
    }
  }

  return generalResult;
}
