/**
 * Supermemory.ai Memory Adapter
 *
 * Integration with supermemory.ai for semantic memory storage and retrieval.
 * Provides AI-optimized search with embedding-based similarity.
 *
 * @see https://supermemory.ai/docs
 */
/**
 * Supermemory.ai adapter for semantic memory storage
 */
export class SupermemoryAdapter {
    type = 'supermemory';
    apiKey;
    endpoint;
    container;
    defaultAgentId;
    defaultProjectId;
    timeout;
    initialized = false;
    constructor(options) {
        if (!options.apiKey) {
            throw new Error('SupermemoryAdapter requires an API key');
        }
        this.apiKey = options.apiKey;
        this.endpoint = options.endpoint ?? 'https://api.supermemory.ai';
        this.container = options.container;
        this.defaultAgentId = options.defaultAgentId;
        this.defaultProjectId = options.defaultProjectId;
        this.timeout = options.timeout ?? 30000;
    }
    async init() {
        // Verify API key by making a simple request
        try {
            const response = await this.fetch('/v3/documents/list', {
                method: 'POST',
                body: JSON.stringify({ limit: 1 }),
            });
            if (!response.ok && response.status !== 404) {
                const error = await response.text();
                throw new Error(`Supermemory API error: ${error}`);
            }
            this.initialized = true;
        }
        catch (error) {
            if (error instanceof Error && error.message.includes('fetch')) {
                throw new Error(`Failed to connect to Supermemory API: ${error.message}`);
            }
            throw error;
        }
    }
    async add(content, options) {
        try {
            const metadata = {
                source: options?.source ?? 'agent-relay',
                agentId: options?.agentId ?? this.defaultAgentId,
                projectId: options?.projectId ?? this.defaultProjectId,
                sessionId: options?.sessionId,
                tags: options?.tags,
                ...options?.metadata,
            };
            // Remove undefined values
            Object.keys(metadata).forEach(key => {
                if (metadata[key] === undefined) {
                    delete metadata[key];
                }
            });
            const body = {
                content,
                metadata,
            };
            if (this.container) {
                body.containerTags = [this.container];
            }
            const response = await this.fetch('/v3/documents', {
                method: 'POST',
                body: JSON.stringify(body),
            });
            if (!response.ok) {
                const error = await response.text();
                return { success: false, error: `Failed to add memory: ${error}` };
            }
            const result = await response.json();
            return { success: true, id: result.id ?? result.documentId };
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }
    async search(query) {
        try {
            const filters = {};
            if (query.agentId) {
                filters.agentId = query.agentId;
            }
            if (query.projectId) {
                filters.projectId = query.projectId;
            }
            if (query.tags && query.tags.length > 0) {
                filters.tags = query.tags;
            }
            const body = {
                query: query.query,
                limit: query.limit ?? 10,
                minScore: query.minScore ?? 0.5,
            };
            if (Object.keys(filters).length > 0) {
                body.filters = filters;
            }
            if (this.container) {
                body.containerTags = [this.container];
            }
            // Use v4 search for lower latency
            const response = await this.fetch('/v4/search', {
                method: 'POST',
                body: JSON.stringify(body),
            });
            if (!response.ok) {
                console.error('[supermemory] Search failed:', await response.text());
                return [];
            }
            const result = await response.json();
            const results = result.results ?? [];
            return results.map(doc => this.documentToMemoryEntry(doc));
        }
        catch (error) {
            console.error('[supermemory] Search error:', error);
            return [];
        }
    }
    async get(id) {
        try {
            const response = await this.fetch(`/v3/documents/${encodeURIComponent(id)}`, {
                method: 'GET',
            });
            if (!response.ok) {
                if (response.status === 404) {
                    return null;
                }
                console.error('[supermemory] Get failed:', await response.text());
                return null;
            }
            const doc = await response.json();
            return this.documentToMemoryEntry(doc);
        }
        catch (error) {
            console.error('[supermemory] Get error:', error);
            return null;
        }
    }
    async delete(id) {
        try {
            const response = await this.fetch(`/v3/documents/${encodeURIComponent(id)}`, {
                method: 'DELETE',
            });
            if (!response.ok && response.status !== 404) {
                const error = await response.text();
                return { success: false, error: `Failed to delete: ${error}` };
            }
            return { success: true, id };
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }
    async update(id, content, options) {
        try {
            const body = { content };
            if (options) {
                const metadata = {};
                if (options.tags)
                    metadata.tags = options.tags;
                if (options.metadata)
                    Object.assign(metadata, options.metadata);
                if (Object.keys(metadata).length > 0) {
                    body.metadata = metadata;
                }
            }
            const response = await this.fetch(`/v3/documents/${encodeURIComponent(id)}`, {
                method: 'PATCH',
                body: JSON.stringify(body),
            });
            if (!response.ok) {
                const error = await response.text();
                return { success: false, error: `Failed to update: ${error}` };
            }
            return { success: true, id };
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }
    async list(options) {
        try {
            const body = {
                limit: options?.limit ?? 50,
                sortBy: 'createdAt',
                sortOrder: 'desc',
            };
            const filters = {};
            if (options?.agentId)
                filters.agentId = options.agentId;
            if (options?.projectId)
                filters.projectId = options.projectId;
            if (Object.keys(filters).length > 0) {
                body.filters = filters;
            }
            if (this.container) {
                body.containerTags = [this.container];
            }
            const response = await this.fetch('/v3/documents/list', {
                method: 'POST',
                body: JSON.stringify(body),
            });
            if (!response.ok) {
                console.error('[supermemory] List failed:', await response.text());
                return [];
            }
            const result = await response.json();
            return (result.documents ?? []).map(doc => this.documentToMemoryEntry(doc));
        }
        catch (error) {
            console.error('[supermemory] List error:', error);
            return [];
        }
    }
    async clear(options) {
        try {
            // Supermemory supports bulk delete by container tags
            // For more specific filtering, we need to list and delete individually
            if (!options?.agentId && !options?.projectId && this.container) {
                // Delete by container
                const response = await this.fetch('/v3/documents/bulk', {
                    method: 'DELETE',
                    body: JSON.stringify({ containerTags: [this.container] }),
                });
                if (!response.ok) {
                    return { success: false, error: await response.text() };
                }
                return { success: true };
            }
            // List and delete matching memories
            const memories = await this.list({
                limit: 1000,
                agentId: options?.agentId,
                projectId: options?.projectId,
            });
            const toDelete = options?.before
                ? memories.filter(m => m.createdAt < options.before)
                : memories;
            for (const memory of toDelete) {
                await this.delete(memory.id);
            }
            return { success: true };
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }
    async stats() {
        // Supermemory doesn't have a stats endpoint, so we approximate
        const memories = await this.list({ limit: 1000 });
        const byAgent = {};
        const byProject = {};
        for (const memory of memories) {
            if (memory.agentId) {
                byAgent[memory.agentId] = (byAgent[memory.agentId] ?? 0) + 1;
            }
            if (memory.projectId) {
                byProject[memory.projectId] = (byProject[memory.projectId] ?? 0) + 1;
            }
        }
        return {
            totalCount: memories.length,
            byAgent,
            byProject,
        };
    }
    async close() {
        this.initialized = false;
    }
    /**
     * Make a fetch request to the Supermemory API
     */
    async fetch(path, options) {
        const url = `${this.endpoint}${path}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);
        try {
            const response = await fetch(url, {
                ...options,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`,
                    ...options.headers,
                },
                signal: controller.signal,
            });
            return response;
        }
        finally {
            clearTimeout(timeoutId);
        }
    }
    /**
     * Convert a Supermemory document to a MemoryEntry
     */
    documentToMemoryEntry(doc) {
        const metadata = doc.metadata ?? {};
        return {
            id: doc.id,
            content: doc.content,
            createdAt: doc.createdAt
                ? new Date(doc.createdAt).getTime()
                : Date.now(),
            tags: metadata.tags,
            source: metadata.source,
            agentId: metadata.agentId,
            projectId: metadata.projectId,
            sessionId: metadata.sessionId,
            score: doc.score,
            metadata,
        };
    }
}
//# sourceMappingURL=supermemory.js.map