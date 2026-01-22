/**
 * OpenAPI Generation Script
 *
 * Generates OpenAPI 3.1 specification from Zod schemas.
 * Run with: npm run generate:openapi
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
  OpenApiGeneratorV31,
} from '@asteasolutions/zod-to-openapi';

// Extend Zod with OpenAPI support
extendZodWithOpenApi(z);

// Import all schemas
import {
  AgentSchema,
  AgentSummarySchema,
  MessageSchema,
  SessionSchema,
  FleetDataSchema,
  FleetServerSchema,
  FleetStatsSchema,
  TaskAssignmentSchema,
  ApiDecisionSchema,
  DecisionSchema,
  TrajectorySchema,
  SendMessageRequestSchema,
  SpawnAgentRequestSchema,
  SpawnAgentResponseSchema,
  CreateTaskRequestSchema,
  CreateBeadRequestSchema,
  ActivityEventSchema,
  HistorySessionSchema,
  HistoryMessageSchema,
  ConversationSchema,
  HistoryStatsSchema,
  FileSearchResponseSchema,
} from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Create registry
const registry = new OpenAPIRegistry();

// Register schemas with OpenAPI metadata
// Note: Schemas with z.lazy() (recursive types) are skipped as they require special handling
registry.register('Agent', AgentSchema.openapi('Agent'));
registry.register('AgentSummary', AgentSummarySchema.openapi('AgentSummary'));
registry.register('Message', MessageSchema.openapi('Message'));
registry.register('Session', SessionSchema.openapi('Session'));
// FleetDataSchema contains AgentSchema which is already registered
registry.register('FleetServer', FleetServerSchema.openapi('FleetServer'));
registry.register('FleetStats', FleetStatsSchema.openapi('FleetStats'));
registry.register('TaskAssignment', TaskAssignmentSchema.openapi('TaskAssignment'));
registry.register('ApiDecision', ApiDecisionSchema.openapi('ApiDecision'));
registry.register('Decision', DecisionSchema.openapi('Decision'));
// TrajectorySchema uses z.lazy() for recursive children - skipped for now
// registry.register('Trajectory', TrajectorySchema.openapi('Trajectory'));
registry.register('SendMessageRequest', SendMessageRequestSchema.openapi('SendMessageRequest'));
registry.register('SpawnAgentRequest', SpawnAgentRequestSchema.openapi('SpawnAgentRequest'));
registry.register('SpawnAgentResponse', SpawnAgentResponseSchema.openapi('SpawnAgentResponse'));
registry.register('CreateTaskRequest', CreateTaskRequestSchema.openapi('CreateTaskRequest'));
registry.register('CreateBeadRequest', CreateBeadRequestSchema.openapi('CreateBeadRequest'));
registry.register('ActivityEvent', ActivityEventSchema.openapi('ActivityEvent'));
registry.register('HistorySession', HistorySessionSchema.openapi('HistorySession'));
registry.register('HistoryMessage', HistoryMessageSchema.openapi('HistoryMessage'));
registry.register('Conversation', ConversationSchema.openapi('Conversation'));
registry.register('HistoryStats', HistoryStatsSchema.openapi('HistoryStats'));
registry.register('FileSearchResponse', FileSearchResponseSchema.openapi('FileSearchResponse'));

// Generate OpenAPI spec
const generator = new OpenApiGeneratorV31(registry.definitions);
const spec = generator.generateDocument({
  openapi: '3.1.0',
  info: {
    title: 'Agent Relay API',
    version: '1.0.0',
    description: 'API types and schemas for Agent Relay communication system',
  },
  servers: [
    {
      url: 'http://localhost:3888',
      description: 'Local development server',
    },
  ],
});

// Output path
const outputDir = join(__dirname, '..', 'dist');
const outputPath = join(outputDir, 'openapi.json');

// Ensure dist directory exists
mkdirSync(outputDir, { recursive: true });

// Write spec
writeFileSync(outputPath, JSON.stringify(spec, null, 2));
console.log(`OpenAPI spec generated at: ${outputPath}`);
console.log(`Registered ${Object.keys(spec.components?.schemas ?? {}).length} schemas`);
