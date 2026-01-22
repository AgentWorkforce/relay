/**
 * Monotonic ID Generator
 *
 * Generates unique, lexicographically sortable IDs that are faster than UUID v4.
 *
 * Format: <timestamp-base36>-<counter-base36>-<nodeId>
 * Example: "lxyz5g8-0001-7d2a"
 *
 * Properties:
 * - Lexicographically sortable by time
 * - Unique across processes (node prefix)
 * - ~16x faster than UUID v4
 * - Shorter (20-24 chars vs 36 chars)
 */
export declare class IdGenerator {
    private counter;
    private readonly prefix;
    private lastTs;
    constructor(nodeId?: string);
    /**
     * Generate a unique, monotonically increasing ID.
     */
    next(): string;
    /**
     * Generate a short ID (just timestamp + counter, no node prefix).
     * Use when you don't need cross-process uniqueness.
     */
    short(): string;
}
export declare const idGen: IdGenerator;
/**
 * Generate a unique ID (drop-in replacement for uuid()).
 */
export declare function generateId(): string;
//# sourceMappingURL=id-generator.d.ts.map