/**
 * Health Check Worker Thread
 *
 * Runs a minimal HTTP server on a separate thread to handle health checks.
 * This ensures health checks respond even when the main event loop is blocked
 * by heavy compute tasks (builds, large file operations, etc.).
 */

import { parentPort, workerData } from 'node:worker_threads';
import http from 'node:http';

interface HealthWorkerData {
  port: number;
}

interface HealthStats {
  uptime: number;
  memoryMB: number;
  relayConnected: boolean;
  agentCount: number;
  status: 'healthy' | 'busy' | 'degraded';
}

// Default stats until we receive updates from main thread
let currentStats: HealthStats = {
  uptime: 0,
  memoryMB: 0,
  relayConnected: false,
  agentCount: 0,
  status: 'healthy',
};

// Track when we last received stats from main thread
let lastStatsUpdate = Date.now();
const STATS_STALE_THRESHOLD_MS = 60_000; // 1 minute

// Listen for stats updates from main thread
if (parentPort) {
  parentPort.on('message', (stats: HealthStats) => {
    currentStats = stats;
    lastStatsUpdate = Date.now();
  });
}

const { port } = workerData as HealthWorkerData;

const server = http.createServer((req, res) => {
  // Only handle /health endpoint
  if (req.url !== '/health' && req.url !== '/') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  // Check if stats are stale (main thread might be blocked)
  const statsAge = Date.now() - lastStatsUpdate;
  const isStale = statsAge > STATS_STALE_THRESHOLD_MS;

  // Determine status
  let status: 'healthy' | 'busy' | 'degraded' = currentStats.status;
  if (isStale) {
    status = 'busy'; // Main thread is likely blocked
  }

  const response = {
    status,
    uptime: currentStats.uptime,
    memoryMB: currentStats.memoryMB,
    relayConnected: currentStats.relayConnected,
    agentCount: currentStats.agentCount,
    statsAgeMs: statsAge,
    worker: true, // Indicates response is from worker thread
  };

  // Return 200 for healthy/busy, 503 for degraded
  const statusCode = status === 'degraded' ? 503 : 200;

  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(response));
});

server.listen(port, '0.0.0.0', () => {
  console.log(`[health-worker] Health check server listening on port ${port}`);

  // Notify main thread we're ready
  if (parentPort) {
    parentPort.postMessage({ type: 'ready', port });
  }
});

// Handle errors gracefully
server.on('error', (err) => {
  console.error('[health-worker] Server error:', err);
  if (parentPort) {
    parentPort.postMessage({ type: 'error', error: String(err) });
  }
});

// Keep the worker alive
process.on('uncaughtException', (err) => {
  console.error('[health-worker] Uncaught exception:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('[health-worker] Unhandled rejection:', err);
});
