/**
 * Embedding Providers
 *
 * Converts text to vector embeddings for semantic search.
 */

import OpenAI from 'openai';

export interface Embedder {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
}

/**
 * OpenAI Embeddings
 */
export class OpenAIEmbedder implements Embedder {
  private client: OpenAI;
  private model: string;
  readonly dimensions: number;

  constructor(config: { apiKey: string; model?: string }) {
    this.client = new OpenAI({ apiKey: config.apiKey });
    this.model = config.model || 'text-embedding-3-small';

    // Set dimensions based on model
    this.dimensions = this.model.includes('large') ? 3072 : 1536;
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: text,
    });
    return response.data[0].embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts,
    });
    return response.data.map((d) => d.embedding);
  }
}

/**
 * Mock Embedder for Testing
 */
export class MockEmbedder implements Embedder {
  readonly dimensions = 384;

  async embed(text: string): Promise<number[]> {
    // Generate deterministic pseudo-random embedding based on text
    const embedding = new Array(this.dimensions).fill(0);
    for (let i = 0; i < text.length && i < this.dimensions; i++) {
      embedding[i] = (text.charCodeAt(i) % 100) / 100 - 0.5;
    }
    return this.normalize(embedding);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  private normalize(vec: number[]): number[] {
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    return vec.map((v) => v / (norm || 1));
  }
}
