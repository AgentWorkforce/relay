/**
 * Agent Relay Cloud - Main Entry Point
 *
 * One-click server provisioning for AI agent orchestration.
 */

export { createServer } from './server';
export { getConfig, loadConfig, CloudConfig } from './config';

// Services
export { CredentialVault } from './vault';
export { WorkspaceProvisioner, ProvisionConfig, Workspace, WorkspaceStatus } from './provisioner';

// Run if executed directly
if (require.main === module) {
  (async () => {
    try {
      const { createServer } = await import('./server');
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
