/**
 * In-Memory Memory Adapter
 *
 * A simple in-memory implementation of the MemoryAdapter interface.
 * Useful for testing and development. Does not persist across restarts.
 *
 * For semantic search, this adapter uses simple keyword matching.
 * For production use with semantic search, use SupermemoryAdapter or similar.
 */
import { randomUUID } from 'node:crypto';
/**
 * In-memory storage adapter for memories
 */
export class InMemoryAdapter {
    type = 'inmemory';
    memories = new Map();
    maxMemories;
    defaultAgentId;
    defaultProjectId;
    constructor(options = {}) {
        this.maxMemories = options.maxMemories ?? 1000;
        this.defaultAgentId = options.defaultAgentId;
        this.defaultProjectId = options.defaultProjectId;
    }
    async init() {
        // No initialization needed for in-memory storage
    }
    async add(content, options) {
        const id = randomUUID();
        const now = Date.now();
        const entry = {
            id,
            content,
            createdAt: now,
            lastAccessedAt: now,
            tags: options?.tags,
            source: options?.source ?? 'agent',
            agentId: options?.agentId ?? this.defaultAgentId,
            projectId: options?.projectId ?? this.defaultProjectId,
            sessionId: options?.sessionId,
            metadata: options?.metadata,
        };
        this.memories.set(id, entry);
        // Prune if over limit
        if (this.memories.size > this.maxMemories) {
            this.pruneOldest();
        }
        return { success: true, id };
    }
    async search(query) {
        const results = [];
        const queryLower = query.query.toLowerCase();
        const queryTerms = queryLower.split(/\s+/).filter(t => t.length > 2);
        for (const entry of this.memories.values()) {
            // Apply filters
            if (query.agentId && entry.agentId !== query.agentId)
                continue;
            if (query.projectId && entry.projectId !== query.projectId)
                continue;
            if (query.since && entry.createdAt < query.since)
                continue;
            if (query.before && entry.createdAt > query.before)
                continue;
            if (query.tags && query.tags.length > 0) {
                if (!entry.tags || !query.tags.some(t => entry.tags.includes(t))) {
                    continue;
                }
            }
            // Simple keyword-based scoring
            const contentLower = entry.content.toLowerCase();
            let score = 0;
            // Exact phrase match gets highest score
            if (contentLower.includes(queryLower)) {
                score += 0.5;
            }
            // Term frequency scoring
            for (const term of queryTerms) {
                const matches = (contentLower.match(new RegExp(term, 'gi')) || []).length;
                score += matches * 0.1;
            }
            // Normalize score to 0-1 range
            score = Math.min(1, score);
            if (score > 0 && (!query.minScore || score >= query.minScore)) {
                // Update last accessed time
                entry.lastAccessedAt = Date.now();
                results.push({ ...entry, score });
            }
        }
        // Sort by score descending
        results.sort((a, b) => b.score - a.score);
        // Apply limit
        const limit = query.limit ?? 10;
        return results.slice(0, limit);
    }
    async get(id) {
        const entry = this.memories.get(id);
        if (entry) {
            entry.lastAccessedAt = Date.now();
            return { ...entry };
        }
        return null;
    }
    async delete(id) {
        const deleted = this.memories.delete(id);
        return {
            success: deleted,
            id,
            error: deleted ? undefined : 'Memory not found',
        };
    }
    async update(id, content, options) {
        const existing = this.memories.get(id);
        if (!existing) {
            return { success: false, error: 'Memory not found' };
        }
        const updated = {
            ...existing,
            content,
            lastAccessedAt: Date.now(),
            ...(options?.tags && { tags: options.tags }),
            ...(options?.metadata && { metadata: { ...existing.metadata, ...options.metadata } }),
        };
        this.memories.set(id, updated);
        return { success: true, id };
    }
    async list(options) {
        const results = [];
        for (const entry of this.memories.values()) {
            if (options?.agentId && entry.agentId !== options.agentId)
                continue;
            if (options?.projectId && entry.projectId !== options.projectId)
                continue;
            results.push({ ...entry });
        }
        // Sort by creation time descending
        results.sort((a, b) => b.createdAt - a.createdAt);
        const limit = options?.limit ?? 50;
        return results.slice(0, limit);
    }
    async clear(options) {
        let _count = 0;
        const toDelete = [];
        for (const [id, entry] of this.memories.entries()) {
            let shouldDelete = true;
            if (options?.agentId && entry.agentId !== options.agentId) {
                shouldDelete = false;
            }
            if (options?.projectId && entry.projectId !== options.projectId) {
                shouldDelete = false;
            }
            if (options?.before && entry.createdAt >= options.before) {
                shouldDelete = false;
            }
            if (shouldDelete) {
                toDelete.push(id);
            }
        }
        for (const id of toDelete) {
            this.memories.delete(id);
            _count++;
        }
        return { success: true };
    }
    async stats() {
        const byAgent = {};
        const byProject = {};
        for (const entry of this.memories.values()) {
            if (entry.agentId) {
                byAgent[entry.agentId] = (byAgent[entry.agentId] ?? 0) + 1;
            }
            if (entry.projectId) {
                byProject[entry.projectId] = (byProject[entry.projectId] ?? 0) + 1;
            }
        }
        return {
            totalCount: this.memories.size,
            byAgent,
            byProject,
        };
    }
    async close() {
        this.memories.clear();
    }
    /**
     * Remove oldest memories when over limit
     */
    pruneOldest() {
        const sorted = Array.from(this.memories.entries()).sort(([, a], [, b]) => a.createdAt - b.createdAt);
        const toRemove = sorted.slice(0, this.memories.size - this.maxMemories);
        for (const [id] of toRemove) {
            this.memories.delete(id);
        }
    }
}
//# sourceMappingURL=inmemory.js.map