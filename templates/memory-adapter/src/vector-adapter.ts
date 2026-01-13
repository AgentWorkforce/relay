/**
 * Vector Memory Adapter
 *
 * In-memory vector store with cosine similarity search.
 * Replace with Pinecone/Qdrant/pgvector for production.
 */

import type { Embedder } from './embedder.js';

export interface MemoryEntry {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
  embedding?: number[];
}

export interface MemorySearchQuery {
  text: string;
  limit?: number;
  filter?: {
    agent?: string;
    type?: string;
    tags?: string[];
    after?: number;
  };
  minScore?: number;
}

export interface MemoryResult {
  id: string;
  content: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface MemoryAdapter {
  add(entry: MemoryEntry): Promise<void>;
  search(query: MemorySearchQuery): Promise<MemoryResult[]>;
  delete(id: string): Promise<void>;
  list(): Promise<MemoryEntry[]>;
}

interface StoredEntry {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  embedding: number[];
}

interface VectorAdapterConfig {
  embedder: Embedder;
  namespace?: string;
}

/**
 * In-Memory Vector Store
 *
 * Good for development and testing.
 * For production, implement Pinecone/Qdrant/pgvector adapters.
 */
export class VectorMemoryAdapter implements MemoryAdapter {
  private embedder: Embedder;
  private namespace: string;
  private entries: Map<string, StoredEntry> = new Map();

  constructor(config: VectorAdapterConfig) {
    this.embedder = config.embedder;
    this.namespace = config.namespace || 'default';
  }

  async add(entry: MemoryEntry): Promise<void> {
    const embedding = entry.embedding || (await this.embedder.embed(entry.content));

    this.entries.set(entry.id, {
      id: entry.id,
      content: entry.content,
      metadata: entry.metadata || {},
      embedding,
    });
  }

  async search(query: MemorySearchQuery): Promise<MemoryResult[]> {
    const queryEmbedding = await this.embedder.embed(query.text);
    const limit = query.limit || 10;
    const minScore = query.minScore || 0;

    const results: Array<{ entry: StoredEntry; score: number }> = [];

    for (const entry of this.entries.values()) {
      // Apply metadata filters
      if (query.filter) {
        if (query.filter.agent && entry.metadata.agent !== query.filter.agent) {
          continue;
        }
        if (query.filter.type && entry.metadata.type !== query.filter.type) {
          continue;
        }
        if (query.filter.after) {
          const ts = entry.metadata.timestamp as number | undefined;
          if (!ts || ts < query.filter.after) continue;
        }
        if (query.filter.tags) {
          const entryTags = entry.metadata.tags as string[] | undefined;
          if (!entryTags || !query.filter.tags.some((t) => entryTags.includes(t))) {
            continue;
          }
        }
      }

      const score = this.cosineSimilarity(queryEmbedding, entry.embedding);
      if (score >= minScore) {
        results.push({ entry, score });
      }
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, limit).map(({ entry, score }) => ({
      id: entry.id,
      content: entry.content,
      score,
      metadata: entry.metadata,
    }));
  }

  async delete(id: string): Promise<void> {
    this.entries.delete(id);
  }

  async list(): Promise<MemoryEntry[]> {
    return Array.from(this.entries.values()).map((e) => ({
      id: e.id,
      content: e.content,
      metadata: e.metadata,
    }));
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error('Vector dimension mismatch');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  // Utility: Get stats
  stats(): { count: number; namespace: string } {
    return {
      count: this.entries.size,
      namespace: this.namespace,
    };
  }

  // Utility: Clear all entries
  clear(): void {
    this.entries.clear();
  }
}
