/**
 * Memory Adapter Example
 *
 * Demonstrates a vector memory system for agents.
 * Uses OpenAI embeddings with an in-memory store.
 * Replace with Pinecone/Qdrant/pgvector for production.
 */

import { RelayClient, getProjectPaths } from 'agent-relay';
import { VectorMemoryAdapter } from './vector-adapter.js';
import { OpenAIEmbedder } from './embedder.js';

async function main() {
  // Initialize embedder
  const embedder = new OpenAIEmbedder({
    apiKey: process.env.OPENAI_API_KEY!,
    model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
  });

  // Initialize memory adapter
  const memory = new VectorMemoryAdapter({
    embedder,
    namespace: process.env.MEMORY_NAMESPACE || 'default',
  });

  // Connect to relay
  const paths = getProjectPaths();
  const relay = new RelayClient({
    name: 'MemoryAgent',
    socketPath: paths.socketPath,
  });

  // Handle memory commands
  relay.on('message', async (msg) => {
    if (msg.from === 'MemoryAgent') return;

    const body = msg.body.trim();

    // Store command: @memory store <content>
    if (body.startsWith('@memory store ')) {
      const content = body.replace('@memory store ', '');
      const id = `mem-${Date.now()}`;

      await memory.add({
        id,
        content,
        metadata: {
          agent: msg.from,
          timestamp: Date.now(),
        },
      });

      await relay.send({
        to: msg.from,
        body: `Stored memory: ${id}`,
      });
      return;
    }

    // Search command: @memory search <query>
    if (body.startsWith('@memory search ')) {
      const query = body.replace('@memory search ', '');
      const results = await memory.search({ text: query, limit: 5 });

      const response = results.length === 0
        ? 'No relevant memories found.'
        : results
            .map((r, i) => `${i + 1}. [${(r.score * 100).toFixed(0)}%] ${r.content.substring(0, 100)}...`)
            .join('\n');

      await relay.send({
        to: msg.from,
        body: response,
      });
      return;
    }

    // Auto-store important messages
    if (msg.data?.remember === true) {
      await memory.add({
        id: `auto-${Date.now()}`,
        content: body,
        metadata: {
          agent: msg.from,
          type: 'auto',
          timestamp: Date.now(),
        },
      });
    }
  });

  await relay.connect();
  console.log('Memory Agent running');
  console.log('Commands:');
  console.log('  @memory store <content> - Store a memory');
  console.log('  @memory search <query>  - Search memories');

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await relay.disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
