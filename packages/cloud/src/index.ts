/**
 * Agent Relay Cloud - Main Entry Point
 *
 * One-click server provisioning for AI agent orchestration.
 */

import { fileURLToPath } from 'node:url';

export { createServer } from './server.js';
export { getConfig, loadConfig, type CloudConfig } from './config.js';

// Services
export {
  WorkspaceProvisioner,
  type ProvisionConfig,
  type Workspace,
  type WorkspaceStatus,
} from './provisioner/index.js';

// Scaling infrastructure
export {
  ScalingPolicyService,
  type ScalingThresholds,
  type ScalingPolicy,
  type ScalingDecision,
  type WorkspaceMetrics,
  getScalingPolicyService,
  AutoScaler,
  type ScalingOperation,
  getAutoScaler,
  createAutoScaler,
  CapacityManager,
  type WorkspaceCapacity,
  type PlacementRecommendation,
  type CapacityForecast,
  getCapacityManager,
  createCapacityManager,
  ScalingOrchestrator,
  type ScalingEvent,
  getScalingOrchestrator,
  createScalingOrchestrator,
} from './services/index.js';

// Billing
export * from './billing/index.js';

// Run if executed directly (ES module compatible check)
const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  (async () => {
    try {
      const { createServer } = await import('./server.js');
      const server = await createServer();
      await server.start();

      // Graceful shutdown
      const shutdown = async () => {
        console.log('\nShutting down...');
        await server.stop();
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    } catch (error) {
      console.error('Failed to start server:', error);
      process.exit(1);
    }
  })();
}
