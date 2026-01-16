# Memory Adapter Template for Agent Relay

Implement vector-based memory for agent context and knowledge retrieval.

## Use Cases

- **RAG (Retrieval Augmented Generation)** - Find relevant context for prompts
- **Long-term Memory** - Remember past conversations and decisions
- **Knowledge Base** - Searchable documentation and code context
- **Cross-Session Context** - Share knowledge between agent sessions

## Supported Backends

This template includes adapters for:
- **In-Memory** - For development/testing
- **OpenAI + Custom** - Bring your own vector store

Add your own:
- Pinecone
- Qdrant
- Weaviate
- pgvector
- Chroma
- Milvus

## Quick Start

```bash
cp .env.example .env
# Add your OPENAI_API_KEY

npm install
npm run dev
```

## Memory Interface

```typescript
interface MemoryAdapter {
  // Store a memory
  add(entry: MemoryEntry): Promise<void>;

  // Semantic search
  search(query: MemorySearchQuery): Promise<MemoryResult[]>;

  // Delete a memory
  delete(id: string): Promise<void>;

  // List all memories (for debugging)
  list(): Promise<MemoryEntry[]>;
}

interface MemoryEntry {
  id: string;
  content: string;           // The text to embed
  metadata?: {
    agent?: string;          // Source agent
    type?: string;           // 'decision', 'observation', 'code', etc.
    timestamp?: number;
    tags?: string[];
    [key: string]: unknown;
  };
  embedding?: number[];      // Pre-computed embedding (optional)
}

interface MemorySearchQuery {
  text: string;              // Search query
  limit?: number;            // Max results (default: 10)
  filter?: {                 // Metadata filters
    agent?: string;
    type?: string;
    tags?: string[];
    after?: number;          // Timestamp filter
  };
  minScore?: number;         // Minimum similarity score
}

interface MemoryResult {
  id: string;
  content: string;
  score: number;             // Similarity score (0-1)
  metadata?: Record<string, unknown>;
}
```

## Usage Examples

### Store Memories

```typescript
const memory = new VectorMemoryAdapter(config);

// Store a decision
await memory.add({
  id: 'decision-123',
  content: 'Chose PostgreSQL over MongoDB for ACID compliance',
  metadata: {
    agent: 'Architect',
    type: 'decision',
    tags: ['database', 'architecture'],
    timestamp: Date.now(),
  },
});

// Store code context
await memory.add({
  id: 'code-user-model',
  content: 'User model with email, passwordHash, createdAt fields',
  metadata: {
    agent: 'Developer',
    type: 'code',
    file: 'src/models/user.ts',
  },
});
```

### Search Memories

```typescript
// Semantic search
const results = await memory.search({
  text: 'database decision',
  limit: 5,
});

// Filtered search
const codeResults = await memory.search({
  text: 'user authentication',
  filter: { type: 'code' },
  limit: 10,
});

// Recent memories only
const recentResults = await memory.search({
  text: 'deployment issues',
  filter: { after: Date.now() - 86400000 },  // Last 24h
});
```

### Integration with Agent Relay

```typescript
import { RelayClient, getProjectPaths } from 'agent-relay';
import { VectorMemoryAdapter } from './vector-adapter.js';

const memory = new VectorMemoryAdapter(config);
const paths = getProjectPaths();

const relay = new RelayClient({
  name: 'MemoryAgent',
  socketPath: paths.socketPath,
});

relay.on('message', async (msg) => {
  // Store all agent communications
  await memory.add({
    id: `msg-${msg.id}`,
    content: msg.body,
    metadata: {
      agent: msg.from,
      type: 'message',
      timestamp: Date.now(),
    },
  });

  // If asked about something, search memory
  if (msg.body.startsWith('remember:')) {
    const query = msg.body.replace('remember:', '').trim();
    const results = await memory.search({ text: query, limit: 5 });

    await relay.send({
      to: msg.from,
      body: formatResults(results),
    });
  }
});
```

## Embedding Providers

### OpenAI (Default)

```typescript
const embedder = new OpenAIEmbedder({
  apiKey: process.env.OPENAI_API_KEY,
  model: 'text-embedding-3-small',  // or text-embedding-3-large
});
```

### Local (Ollama)

```typescript
const embedder = new OllamaEmbedder({
  baseUrl: 'http://localhost:11434',
  model: 'nomic-embed-text',
});
```

### Custom

```typescript
class CustomEmbedder implements Embedder {
  async embed(text: string): Promise<number[]> {
    // Your embedding logic
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    // Batch embedding for efficiency
  }
}
```

## Vector Store Tips

### Dimensionality

- OpenAI `text-embedding-3-small`: 1536 dimensions
- OpenAI `text-embedding-3-large`: 3072 dimensions
- Cohere: 1024 dimensions
- Local models: varies

### Similarity Metrics

- **Cosine** - Best for semantic similarity (recommended)
- **Euclidean** - For distance-based matching
- **Dot Product** - When embeddings are normalized

### Chunking Strategy

For long documents:

```typescript
function chunkText(text: string, maxTokens = 500): string[] {
  // Split by paragraphs, then by sentences if needed
  const paragraphs = text.split('\n\n');
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    if (estimateTokens(current + para) > maxTokens) {
      if (current) chunks.push(current.trim());
      current = para;
    } else {
      current += '\n\n' + para;
    }
  }

  if (current) chunks.push(current.trim());
  return chunks;
}
```

## Testing

```bash
npm test
```

Includes tests for:
- Embedding generation
- Similarity search accuracy
- Metadata filtering
- Edge cases (empty queries, special characters)
