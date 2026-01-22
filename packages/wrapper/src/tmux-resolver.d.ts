/**
 * Tmux Binary Resolver
 *
 * Locates tmux binary with fallback to bundled version.
 * Priority:
 * 1. System tmux (in PATH)
 * 2. Bundled tmux within the agent-relay package (bin/tmux)
 */
/** Path where bundled tmux binary is installed (within the package) */
export declare function getBundledTmuxDir(): string;
export declare function getBundledTmuxPath(): string;
export declare const BUNDLED_TMUX_DIR: string;
export declare const BUNDLED_TMUX_PATH: string;
/** Minimum supported tmux version */
export declare const MIN_TMUX_VERSION = "3.0";
export interface TmuxInfo {
    /** Full path to tmux binary */
    path: string;
    /** Version string (e.g., "3.6a") */
    version: string;
    /** Whether this is the bundled version */
    isBundled: boolean;
}
/**
 * Resolve tmux binary path with fallback to bundled version.
 * Returns null if tmux is not available.
 */
export declare function resolveTmux(): TmuxInfo | null;
/**
 * Get the tmux command to use. Throws if tmux is not available.
 */
export declare function getTmuxPath(): string;
/**
 * Check if tmux is available (either system or bundled)
 */
export declare function isTmuxAvailable(): boolean;
/**
 * Get platform identifier for downloading binaries
 */
export declare function getPlatformIdentifier(): string | null;
/**
 * Error thrown when tmux is not available
 */
export declare class TmuxNotFoundError extends Error {
    constructor();
}
/**
 * Check if installed tmux version meets minimum requirements
 */
export declare function checkTmuxVersion(): {
    ok: boolean;
    version: string | null;
    minimum: string;
};
//# sourceMappingURL=tmux-resolver.d.ts.map