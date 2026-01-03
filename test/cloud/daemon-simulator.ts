#!/usr/bin/env node
/**
 * Daemon Simulator for Cloud QA Testing
 *
 * Simulates a local daemon that:
 * - Links to the cloud API
 * - Reports agent memory metrics
 * - Reports crashes when configured
 * - Reports memory alerts
 *
 * This allows full end-to-end testing of the cloud monitoring infrastructure
 * without needing actual agent processes running.
 */

import crypto from 'crypto';

// Configuration from environment
const config = {
  daemonName: process.env.DAEMON_NAME || 'test-daemon',
  cloudApiUrl: process.env.CLOUD_API_URL || 'http://localhost:3000',
  agentCount: parseInt(process.env.AGENT_COUNT || '3', 10),
  reportIntervalMs: parseInt(process.env.REPORT_INTERVAL_MS || '10000', 10),
  simulateMemoryGrowth: process.env.SIMULATE_MEMORY_GROWTH === 'true',
  simulateCrash: process.env.SIMULATE_CRASH === 'true',
  crashAfterSeconds: parseInt(process.env.CRASH_AFTER_SECONDS || '60', 10),
};

interface Agent {
  name: string;
  pid: number;
  startedAt: Date;
  rssBytes: number;
  heapUsedBytes: number;
  cpuPercent: number;
  trend: 'growing' | 'stable' | 'shrinking' | 'unknown';
  trendRatePerMinute: number;
  alertLevel: 'normal' | 'warning' | 'critical' | 'oom_imminent';
  highWatermark: number;
  averageRss: number;
}

interface DaemonState {
  id: string;
  apiKey: string;
  agents: Agent[];
  crashCount: number;
}

const state: DaemonState = {
  id: '',
  apiKey: '',
  agents: [],
  crashCount: 0,
};

// Generate realistic agent names
function generateAgentName(index: number): string {
  const prefixes = ['worker', 'processor', 'handler', 'analyzer', 'builder'];
  const prefix = prefixes[index % prefixes.length];
  return `${prefix}-${config.daemonName}-${index}`;
}

// Generate random PID
function generatePid(): number {
  return Math.floor(Math.random() * 50000) + 10000;
}

// Initialize simulated agents
function initAgents(): void {
  for (let i = 0; i < config.agentCount; i++) {
    const baseMemory = (50 + Math.random() * 200) * 1024 * 1024; // 50-250 MB
    state.agents.push({
      name: generateAgentName(i),
      pid: generatePid(),
      startedAt: new Date(Date.now() - Math.random() * 3600000), // Up to 1 hour ago
      rssBytes: baseMemory,
      heapUsedBytes: baseMemory * 0.6,
      cpuPercent: Math.random() * 30,
      trend: 'stable',
      trendRatePerMinute: 0,
      alertLevel: 'normal',
      highWatermark: baseMemory,
      averageRss: baseMemory,
    });
  }
  console.log(`[daemon-sim] Initialized ${state.agents.length} simulated agents`);
}

// Update agent metrics (simulate memory changes)
function updateAgentMetrics(): void {
  for (const agent of state.agents) {
    // Simulate CPU fluctuation
    agent.cpuPercent = Math.max(0, Math.min(100, agent.cpuPercent + (Math.random() - 0.5) * 10));

    // Simulate memory changes
    let memoryDelta = (Math.random() - 0.5) * 10 * 1024 * 1024; // +/- 10MB

    if (config.simulateMemoryGrowth) {
      // Add gradual growth (simulating memory leak)
      memoryDelta += 5 * 1024 * 1024; // +5MB per interval
    }

    agent.rssBytes = Math.max(10 * 1024 * 1024, agent.rssBytes + memoryDelta);
    agent.heapUsedBytes = agent.rssBytes * 0.6;

    // Update high watermark
    if (agent.rssBytes > agent.highWatermark) {
      agent.highWatermark = agent.rssBytes;
    }

    // Calculate trend
    const rate = memoryDelta / (config.reportIntervalMs / 60000); // per minute
    agent.trendRatePerMinute = rate;

    if (rate > 1024 * 1024) {
      agent.trend = 'growing';
    } else if (rate < -1024 * 1024) {
      agent.trend = 'shrinking';
    } else {
      agent.trend = 'stable';
    }

    // Update rolling average (simplified)
    agent.averageRss = (agent.averageRss * 0.9) + (agent.rssBytes * 0.1);

    // Update alert level based on thresholds
    if (agent.rssBytes >= 1.5 * 1024 * 1024 * 1024) {
      agent.alertLevel = 'oom_imminent';
    } else if (agent.rssBytes >= 1024 * 1024 * 1024) {
      agent.alertLevel = 'critical';
    } else if (agent.rssBytes >= 512 * 1024 * 1024) {
      agent.alertLevel = 'warning';
    } else {
      agent.alertLevel = 'normal';
    }
  }
}

// Link daemon to cloud (get API key)
async function linkDaemon(): Promise<boolean> {
  console.log(`[daemon-sim] Linking daemon "${config.daemonName}" to cloud...`);

  try {
    // First, we need to create a test user and get a session
    // In real usage, this would go through OAuth, but for testing we'll use a direct approach
    const machineId = crypto.randomBytes(16).toString('hex');

    // Start linking flow
    const startRes = await fetch(`${config.cloudApiUrl}/api/daemons/link/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: config.daemonName,
        machineId,
        hostname: 'test-host',
        platform: 'linux',
        version: '1.0.0-test',
      }),
    });

    if (!startRes.ok) {
      // If linking requires auth, use test mode
      console.log('[daemon-sim] Standard linking failed, using test mode...');
      return await linkDaemonTestMode();
    }

    const { linkCode } = await startRes.json();
    console.log(`[daemon-sim] Got link code: ${linkCode}`);

    // In test mode, auto-approve the link
    // This would normally require user action in browser
    const completeRes = await fetch(`${config.cloudApiUrl}/api/daemons/link/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ linkCode }),
    });

    if (!completeRes.ok) {
      throw new Error(`Complete linking failed: ${completeRes.status}`);
    }

    const { daemonId, apiKey } = await completeRes.json();
    state.id = daemonId;
    state.apiKey = apiKey;

    console.log(`[daemon-sim] Linked successfully! Daemon ID: ${daemonId}`);
    return true;
  } catch (error) {
    console.error('[daemon-sim] Failed to link daemon:', error);
    return false;
  }
}

// Test mode linking (creates test daemon directly)
async function linkDaemonTestMode(): Promise<boolean> {
  try {
    // Use test endpoint that creates daemon without auth
    const res = await fetch(`${config.cloudApiUrl}/api/test/create-daemon`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: config.daemonName,
        machineId: crypto.randomBytes(16).toString('hex'),
      }),
    });

    if (!res.ok) {
      // Create a mock daemon for testing without cloud
      console.log('[daemon-sim] Test endpoint not available, using mock mode');
      state.id = `mock-${crypto.randomBytes(8).toString('hex')}`;
      state.apiKey = `ar_live_test_${crypto.randomBytes(16).toString('hex')}`;
      return true;
    }

    const { daemonId, apiKey } = await res.json();
    state.id = daemonId;
    state.apiKey = apiKey;
    console.log(`[daemon-sim] Test mode linked! Daemon ID: ${daemonId}`);
    return true;
  } catch (error) {
    console.error('[daemon-sim] Test mode linking failed:', error);
    // Fall back to mock mode
    state.id = `mock-${crypto.randomBytes(8).toString('hex')}`;
    state.apiKey = `ar_live_test_${crypto.randomBytes(16).toString('hex')}`;
    console.log('[daemon-sim] Using mock mode');
    return true;
  }
}

// Report metrics to cloud
async function reportMetrics(): Promise<void> {
  if (!state.apiKey) {
    console.warn('[daemon-sim] No API key, skipping metrics report');
    return;
  }

  try {
    const agents = state.agents.map((a) => ({
      name: a.name,
      pid: a.pid,
      status: 'running',
      rssBytes: Math.round(a.rssBytes),
      heapUsedBytes: Math.round(a.heapUsedBytes),
      cpuPercent: a.cpuPercent,
      trend: a.trend,
      trendRatePerMinute: Math.round(a.trendRatePerMinute),
      alertLevel: a.alertLevel,
      highWatermark: Math.round(a.highWatermark),
      averageRss: Math.round(a.averageRss),
      uptimeMs: Date.now() - a.startedAt.getTime(),
      startedAt: a.startedAt.toISOString(),
    }));

    const res = await fetch(`${config.cloudApiUrl}/api/monitoring/metrics`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.apiKey}`,
      },
      body: JSON.stringify({ agents }),
    });

    if (!res.ok) {
      console.warn(`[daemon-sim] Failed to report metrics: ${res.status}`);
    } else {
      const result = await res.json();
      console.log(`[daemon-sim] Reported metrics for ${result.recorded} agents`);
    }
  } catch (error) {
    console.error('[daemon-sim] Error reporting metrics:', error);
  }
}

// Report a crash
async function reportCrash(agent: Agent): Promise<void> {
  if (!state.apiKey) return;

  try {
    const crash = {
      agentName: agent.name,
      pid: agent.pid,
      exitCode: 137, // SIGKILL (OOM)
      signal: 'SIGKILL',
      reason: 'Simulated crash for testing',
      likelyCause: config.simulateMemoryGrowth ? 'oom' : 'unknown',
      confidence: 'high',
      summary: `Agent ${agent.name} crashed during testing`,
      peakMemory: agent.highWatermark,
      lastKnownMemory: agent.rssBytes,
      memoryTrend: agent.trend,
      crashedAt: new Date().toISOString(),
    };

    const res = await fetch(`${config.cloudApiUrl}/api/monitoring/crash`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.apiKey}`,
      },
      body: JSON.stringify({ crash }),
    });

    if (!res.ok) {
      console.warn(`[daemon-sim] Failed to report crash: ${res.status}`);
    } else {
      const result = await res.json();
      console.log(`[daemon-sim] Reported crash: ${result.crashId}`);
      state.crashCount++;
    }
  } catch (error) {
    console.error('[daemon-sim] Error reporting crash:', error);
  }
}

// Report alert
async function reportAlert(agent: Agent, type: string): Promise<void> {
  if (!state.apiKey) return;

  try {
    const alert = {
      agentName: agent.name,
      alertType: type,
      currentRss: Math.round(agent.rssBytes),
      threshold: type === 'warning' ? 512 * 1024 * 1024 :
                 type === 'critical' ? 1024 * 1024 * 1024 :
                 1.5 * 1024 * 1024 * 1024,
      message: `Agent ${agent.name} has ${type} memory level`,
      recommendation: 'Consider restarting the agent or investigating memory usage',
    };

    const res = await fetch(`${config.cloudApiUrl}/api/monitoring/alert`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.apiKey}`,
      },
      body: JSON.stringify({ alert }),
    });

    if (!res.ok) {
      console.warn(`[daemon-sim] Failed to report alert: ${res.status}`);
    } else {
      console.log(`[daemon-sim] Reported ${type} alert for ${agent.name}`);
    }
  } catch (error) {
    console.error('[daemon-sim] Error reporting alert:', error);
  }
}

// Main simulation loop
async function runSimulation(): Promise<void> {
  console.log('[daemon-sim] Starting daemon simulator...');
  console.log(`[daemon-sim] Config: ${JSON.stringify(config, null, 2)}`);

  // Initialize agents
  initAgents();

  // Link to cloud
  const linked = await linkDaemon();
  if (!linked) {
    console.error('[daemon-sim] Failed to link daemon, exiting');
    process.exit(1);
  }

  // Track previous alert levels for change detection
  const previousAlertLevels = new Map<string, string>();

  // Start simulation loop
  let iteration = 0;
  const startTime = Date.now();

  const interval = setInterval(async () => {
    iteration++;
    console.log(`[daemon-sim] Iteration ${iteration}`);

    // Update metrics
    updateAgentMetrics();

    // Report metrics
    await reportMetrics();

    // Check for alert level changes and report alerts
    for (const agent of state.agents) {
      const prevLevel = previousAlertLevels.get(agent.name) || 'normal';
      if (agent.alertLevel !== prevLevel && agent.alertLevel !== 'normal') {
        await reportAlert(agent, agent.alertLevel);
      }
      previousAlertLevels.set(agent.name, agent.alertLevel);
    }

    // Check for crash simulation
    if (config.simulateCrash) {
      const elapsedSeconds = (Date.now() - startTime) / 1000;
      if (elapsedSeconds >= config.crashAfterSeconds && state.crashCount === 0) {
        console.log('[daemon-sim] Triggering simulated crash...');
        const agent = state.agents[Math.floor(Math.random() * state.agents.length)];
        await reportCrash(agent);

        // Remove crashed agent
        state.agents = state.agents.filter((a) => a.name !== agent.name);

        // Restart agent after a delay (simulating auto-restart)
        setTimeout(() => {
          console.log(`[daemon-sim] Restarting crashed agent: ${agent.name}`);
          agent.pid = generatePid();
          agent.startedAt = new Date();
          agent.rssBytes = 50 * 1024 * 1024;
          agent.highWatermark = agent.rssBytes;
          agent.alertLevel = 'normal';
          state.agents.push(agent);
        }, 10000);
      }
    }
  }, config.reportIntervalMs);

  // Handle shutdown
  process.on('SIGTERM', () => {
    console.log('[daemon-sim] Received SIGTERM, shutting down...');
    clearInterval(interval);
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('[daemon-sim] Received SIGINT, shutting down...');
    clearInterval(interval);
    process.exit(0);
  });
}

// Run the simulation
runSimulation().catch((error) => {
  console.error('[daemon-sim] Fatal error:', error);
  process.exit(1);
});
