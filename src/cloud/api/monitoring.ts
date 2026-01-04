/**
 * Agent Monitoring API Routes
 *
 * Provides endpoints for:
 * - Real-time memory metrics collection
 * - Crash insights and history
 * - Proactive alerting
 * - System health dashboard
 */

import { Router, Request, Response } from 'express';
import { createHash } from 'crypto';
import { eq, desc, and, gte, sql } from 'drizzle-orm';
import { requireAuth } from './auth.js';
import { db as dbModule } from '../db/index.js';
import { getDb } from '../db/drizzle.js';
import {
  linkedDaemons as _linkedDaemons,
  agentMetrics,
  agentCrashes,
  memoryAlerts,
  AgentMemoryMetricsData,
  CrashInsightData,
} from '../db/schema.js';

export const monitoringRouter = Router();

/**
 * Hash an API key for lookup
 */
function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

/**
 * Middleware to authenticate daemon by API key
 */
async function requireDaemonAuth(
  req: Request,
  res: Response,
  next: () => void
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ar_live_')) {
    res.status(401).json({ error: 'Invalid API key format' });
    return;
  }

  const apiKey = authHeader.replace('Bearer ', '');
  const apiKeyHash = hashApiKey(apiKey);

  try {
    const daemon = await dbModule.linkedDaemons.findByApiKeyHash(apiKeyHash);

    if (!daemon) {
      res.status(401).json({ error: 'Invalid API key' });
      return;
    }

    (req as any).daemon = daemon;
    next();
  } catch (error) {
    console.error('Daemon auth error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

// ============================================================================
// Daemon API (authenticated with API key)
// ============================================================================

/**
 * POST /api/monitoring/metrics
 * Report agent memory metrics from daemon
 */
monitoringRouter.post('/metrics', requireDaemonAuth as any, async (req: Request, res: Response) => {
  const daemon = (req as any).daemon;
  const { agents } = req.body;

  if (!agents || !Array.isArray(agents)) {
    return res.status(400).json({ error: 'agents array is required' });
  }

  try {
    const db = getDb();
    const now = new Date();

    // Insert metrics for each agent
    for (const agent of agents) {
      const metricsData: AgentMemoryMetricsData = {
        rssBytes: agent.rssBytes || 0,
        heapUsedBytes: agent.heapUsedBytes || 0,
        heapTotalBytes: agent.heapTotalBytes || 0,
        cpuPercent: agent.cpuPercent || 0,
        trend: agent.trend || 'unknown',
        trendRatePerMinute: agent.trendRatePerMinute || 0,
        alertLevel: agent.alertLevel || 'normal',
        highWatermark: agent.highWatermark || 0,
        averageRss: agent.averageRss || 0,
      };

      await db.insert(agentMetrics).values({
        daemonId: daemon.id,
        agentName: agent.name,
        pid: agent.pid,
        status: agent.status || 'unknown',
        rssBytes: agent.rssBytes,
        heapUsedBytes: agent.heapUsedBytes,
        cpuPercent: Math.round(agent.cpuPercent || 0),
        trend: agent.trend,
        trendRatePerMinute: Math.round(agent.trendRatePerMinute || 0),
        alertLevel: agent.alertLevel,
        highWatermark: agent.highWatermark,
        averageRss: Math.round(agent.averageRss || 0),
        metricsData,
        uptimeMs: agent.uptimeMs,
        startedAt: agent.startedAt ? new Date(agent.startedAt) : null,
        recordedAt: now,
      });
    }

    res.json({ success: true, recorded: agents.length });
  } catch (error) {
    console.error('Error recording metrics:', error);
    res.status(500).json({ error: 'Failed to record metrics' });
  }
});

/**
 * POST /api/monitoring/crash
 * Report an agent crash from daemon
 */
monitoringRouter.post('/crash', requireDaemonAuth as any, async (req: Request, res: Response) => {
  const daemon = (req as any).daemon;
  const { crash } = req.body;

  if (!crash || !crash.agentName) {
    return res.status(400).json({ error: 'crash object with agentName is required' });
  }

  try {
    const db = getDb();

    const insightData: CrashInsightData = {
      likelyCause: crash.likelyCause || 'unknown',
      confidence: crash.confidence || 'low',
      summary: crash.summary || '',
      details: crash.details || [],
      recommendations: crash.recommendations || [],
      peakMemory: crash.peakMemory || 0,
      lastKnownMemory: crash.lastKnownMemory || null,
    };

    const [inserted] = await db.insert(agentCrashes).values({
      daemonId: daemon.id,
      agentName: crash.agentName,
      pid: crash.pid,
      exitCode: crash.exitCode,
      signal: crash.signal,
      reason: crash.reason,
      likelyCause: crash.likelyCause,
      confidence: crash.confidence,
      summary: crash.summary,
      peakMemory: crash.peakMemory,
      lastKnownMemory: crash.lastKnownMemory,
      memoryTrend: crash.memoryTrend,
      insightData,
      lastOutput: crash.lastOutput?.slice(0, 10000), // Limit to 10KB
      crashedAt: crash.crashedAt ? new Date(crash.crashedAt) : new Date(),
    }).returning();

    res.json({ success: true, crashId: inserted.id });
  } catch (error) {
    console.error('Error recording crash:', error);
    res.status(500).json({ error: 'Failed to record crash' });
  }
});

/**
 * POST /api/monitoring/alert
 * Report a memory alert from daemon
 */
monitoringRouter.post('/alert', requireDaemonAuth as any, async (req: Request, res: Response) => {
  const daemon = (req as any).daemon;
  const { alert } = req.body;

  if (!alert || !alert.agentName || !alert.alertType) {
    return res.status(400).json({ error: 'alert object with agentName and alertType is required' });
  }

  try {
    const db = getDb();

    const [inserted] = await db.insert(memoryAlerts).values({
      daemonId: daemon.id,
      agentName: alert.agentName,
      alertType: alert.alertType,
      currentRss: alert.currentRss,
      threshold: alert.threshold,
      message: alert.message,
      recommendation: alert.recommendation,
    }).returning();

    res.json({ success: true, alertId: inserted.id });
  } catch (error) {
    console.error('Error recording alert:', error);
    res.status(500).json({ error: 'Failed to record alert' });
  }
});

// ============================================================================
// Browser API (authenticated with session)
// ============================================================================

/**
 * GET /api/monitoring/overview
 * Get monitoring overview for user's daemons
 */
monitoringRouter.get('/overview', requireAuth, async (req: Request, res: Response) => {
  const userId = req.session.userId!;

  try {
    const db = getDb();

    // Get all user's daemons
    const daemons = await dbModule.linkedDaemons.findByUserId(userId);

    if (daemons.length === 0) {
      return res.json({
        daemons: [],
        summary: {
          totalAgents: 0,
          healthyAgents: 0,
          warningAgents: 0,
          criticalAgents: 0,
          totalCrashes24h: 0,
          totalAlerts24h: 0,
        },
      });
    }

    const daemonIds = daemons.map(d => d.id);
    const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Get latest metrics for each agent (subquery to get latest per agent)
    const latestMetrics = await db
      .select()
      .from(agentMetrics)
      .where(
        and(
          sql`${agentMetrics.daemonId} IN (${sql.join(daemonIds.map(id => sql`${id}`), sql`, `)})`,
          gte(agentMetrics.recordedAt, last24h)
        )
      )
      .orderBy(desc(agentMetrics.recordedAt))
      .limit(100);

    // Get crash count in last 24h
    const crashCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(agentCrashes)
      .where(
        and(
          sql`${agentCrashes.daemonId} IN (${sql.join(daemonIds.map(id => sql`${id}`), sql`, `)})`,
          gte(agentCrashes.crashedAt, last24h)
        )
      );

    // Get alert count in last 24h
    const alertCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(memoryAlerts)
      .where(
        and(
          sql`${memoryAlerts.daemonId} IN (${sql.join(daemonIds.map(id => sql`${id}`), sql`, `)})`,
          gte(memoryAlerts.createdAt, last24h)
        )
      );

    // Aggregate by alert level
    const byAlertLevel = {
      normal: 0,
      warning: 0,
      critical: 0,
      oom_imminent: 0,
    };

    // Deduplicate by agent name (keep latest)
    const agentLatest = new Map<string, typeof latestMetrics[0]>();
    for (const m of latestMetrics) {
      const key = `${m.daemonId}:${m.agentName}`;
      if (!agentLatest.has(key)) {
        agentLatest.set(key, m);
        byAlertLevel[m.alertLevel as keyof typeof byAlertLevel] =
          (byAlertLevel[m.alertLevel as keyof typeof byAlertLevel] || 0) + 1;
      }
    }

    res.json({
      daemons: daemons.map(d => ({
        id: d.id,
        name: d.name,
        machineId: d.machineId,
        status: d.status,
        lastSeenAt: d.lastSeenAt,
      })),
      summary: {
        totalAgents: agentLatest.size,
        healthyAgents: byAlertLevel.normal,
        warningAgents: byAlertLevel.warning,
        criticalAgents: byAlertLevel.critical + byAlertLevel.oom_imminent,
        totalCrashes24h: Number(crashCount[0]?.count || 0),
        totalAlerts24h: Number(alertCount[0]?.count || 0),
      },
      latestMetrics: Array.from(agentLatest.values()),
    });
  } catch (error) {
    console.error('Error fetching monitoring overview:', error);
    res.status(500).json({ error: 'Failed to fetch monitoring overview' });
  }
});

/**
 * GET /api/monitoring/agents/:agentName/metrics
 * Get detailed metrics history for an agent
 */
monitoringRouter.get('/agents/:agentName/metrics', requireAuth, async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { agentName } = req.params;
  const { daemonId, hours = '24' } = req.query;

  try {
    const db = getDb();

    // Verify daemon belongs to user
    if (daemonId) {
      const daemon = await dbModule.linkedDaemons.findById(daemonId as string);
      if (!daemon || daemon.userId !== userId) {
        return res.status(404).json({ error: 'Daemon not found' });
      }
    }

    const since = new Date(Date.now() - parseInt(hours as string) * 60 * 60 * 1000);

    // Get user's daemons
    const daemons = await dbModule.linkedDaemons.findByUserId(userId);
    const daemonIds = daemonId ? [daemonId] : daemons.map(d => d.id);

    const metrics = await db
      .select()
      .from(agentMetrics)
      .where(
        and(
          sql`${agentMetrics.daemonId} IN (${sql.join(daemonIds.map(id => sql`${id}`), sql`, `)})`,
          eq(agentMetrics.agentName, agentName),
          gte(agentMetrics.recordedAt, since)
        )
      )
      .orderBy(desc(agentMetrics.recordedAt))
      .limit(1000);

    // Calculate statistics
    const rssSamples = metrics.map(m => Number(m.rssBytes || 0));
    const stats = {
      count: metrics.length,
      avgRss: rssSamples.length > 0 ? rssSamples.reduce((a, b) => a + b, 0) / rssSamples.length : 0,
      maxRss: rssSamples.length > 0 ? Math.max(...rssSamples) : 0,
      minRss: rssSamples.length > 0 ? Math.min(...rssSamples) : 0,
      latestTrend: metrics[0]?.trend || 'unknown',
      latestAlertLevel: metrics[0]?.alertLevel || 'normal',
    };

    res.json({
      agentName,
      metrics,
      stats,
    });
  } catch (error) {
    console.error('Error fetching agent metrics:', error);
    res.status(500).json({ error: 'Failed to fetch agent metrics' });
  }
});

/**
 * GET /api/monitoring/crashes
 * Get crash history
 */
monitoringRouter.get('/crashes', requireAuth, async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { daemonId, agentName, limit = '50' } = req.query;

  try {
    const db = getDb();

    // Get user's daemons
    const daemons = await dbModule.linkedDaemons.findByUserId(userId);
    const daemonIds = daemonId ? [daemonId] : daemons.map(d => d.id);

    let query = db
      .select()
      .from(agentCrashes)
      .where(
        sql`${agentCrashes.daemonId} IN (${sql.join(daemonIds.map(id => sql`${id}`), sql`, `)})`
      );

    if (agentName) {
      query = db
        .select()
        .from(agentCrashes)
        .where(
          and(
            sql`${agentCrashes.daemonId} IN (${sql.join(daemonIds.map(id => sql`${id}`), sql`, `)})`,
            eq(agentCrashes.agentName, agentName as string)
          )
        );
    }

    const crashes = await query
      .orderBy(desc(agentCrashes.crashedAt))
      .limit(parseInt(limit as string));

    // Get crash statistics by cause
    const byCause: Record<string, number> = {};
    for (const crash of crashes) {
      const cause = crash.likelyCause || 'unknown';
      byCause[cause] = (byCause[cause] || 0) + 1;
    }

    res.json({
      crashes,
      stats: {
        total: crashes.length,
        byCause,
      },
    });
  } catch (error) {
    console.error('Error fetching crashes:', error);
    res.status(500).json({ error: 'Failed to fetch crashes' });
  }
});

/**
 * GET /api/monitoring/crashes/:id
 * Get detailed crash information
 */
monitoringRouter.get('/crashes/:id', requireAuth, async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { id } = req.params;

  try {
    const db = getDb();

    const [crash] = await db
      .select()
      .from(agentCrashes)
      .where(eq(agentCrashes.id, id))
      .limit(1);

    if (!crash) {
      return res.status(404).json({ error: 'Crash not found' });
    }

    // Verify user owns this daemon
    const daemon = await dbModule.linkedDaemons.findById(crash.daemonId);
    if (!daemon || daemon.userId !== userId) {
      return res.status(404).json({ error: 'Crash not found' });
    }

    res.json({ crash, daemon: { id: daemon.id, name: daemon.name } });
  } catch (error) {
    console.error('Error fetching crash:', error);
    res.status(500).json({ error: 'Failed to fetch crash' });
  }
});

/**
 * GET /api/monitoring/alerts
 * Get memory alerts
 */
monitoringRouter.get('/alerts', requireAuth, async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { daemonId, acknowledged, limit = '100' } = req.query;

  try {
    const db = getDb();

    // Get user's daemons
    const daemons = await dbModule.linkedDaemons.findByUserId(userId);
    const daemonIds = daemonId ? [daemonId] : daemons.map(d => d.id);

    const whereConditions = [
      sql`${memoryAlerts.daemonId} IN (${sql.join(daemonIds.map(id => sql`${id}`), sql`, `)})`
    ];

    if (acknowledged !== undefined) {
      whereConditions.push(eq(memoryAlerts.acknowledged, acknowledged === 'true'));
    }

    const alerts = await db
      .select()
      .from(memoryAlerts)
      .where(and(...whereConditions))
      .orderBy(desc(memoryAlerts.createdAt))
      .limit(parseInt(limit as string));

    // Count unacknowledged
    const unacknowledgedCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(memoryAlerts)
      .where(
        and(
          sql`${memoryAlerts.daemonId} IN (${sql.join(daemonIds.map(id => sql`${id}`), sql`, `)})`,
          eq(memoryAlerts.acknowledged, false)
        )
      );

    res.json({
      alerts,
      unacknowledgedCount: Number(unacknowledgedCount[0]?.count || 0),
    });
  } catch (error) {
    console.error('Error fetching alerts:', error);
    res.status(500).json({ error: 'Failed to fetch alerts' });
  }
});

/**
 * POST /api/monitoring/alerts/:id/acknowledge
 * Acknowledge an alert
 */
monitoringRouter.post('/alerts/:id/acknowledge', requireAuth, async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { id } = req.params;

  try {
    const db = getDb();

    // Get the alert
    const [alert] = await db
      .select()
      .from(memoryAlerts)
      .where(eq(memoryAlerts.id, id))
      .limit(1);

    if (!alert) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    // Verify user owns this daemon
    const daemon = await dbModule.linkedDaemons.findById(alert.daemonId);
    if (!daemon || daemon.userId !== userId) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    // Update alert
    await db
      .update(memoryAlerts)
      .set({
        acknowledged: true,
        acknowledgedAt: new Date(),
      })
      .where(eq(memoryAlerts.id, id));

    res.json({ success: true });
  } catch (error) {
    console.error('Error acknowledging alert:', error);
    res.status(500).json({ error: 'Failed to acknowledge alert' });
  }
});

/**
 * GET /api/monitoring/insights
 * Get overall system insights and recommendations
 */
monitoringRouter.get('/insights', requireAuth, async (req: Request, res: Response) => {
  const userId = req.session.userId!;

  try {
    const db = getDb();

    // Get user's daemons
    const daemons = await dbModule.linkedDaemons.findByUserId(userId);

    if (daemons.length === 0) {
      return res.json({
        healthScore: 100,
        summary: 'No daemons connected. Link a daemon to start monitoring.',
        issues: [],
        recommendations: ['Connect a local daemon using `agent-relay cloud link`'],
      });
    }

    const daemonIds = daemons.map(d => d.id);
    const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const last7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Get crash stats
    const crashes24h = await db
      .select()
      .from(agentCrashes)
      .where(
        and(
          sql`${agentCrashes.daemonId} IN (${sql.join(daemonIds.map(id => sql`${id}`), sql`, `)})`,
          gte(agentCrashes.crashedAt, last24h)
        )
      );

    const crashes7d = await db
      .select()
      .from(agentCrashes)
      .where(
        and(
          sql`${agentCrashes.daemonId} IN (${sql.join(daemonIds.map(id => sql`${id}`), sql`, `)})`,
          gte(agentCrashes.crashedAt, last7d)
        )
      );

    // Get unacknowledged alerts
    const pendingAlerts = await db
      .select()
      .from(memoryAlerts)
      .where(
        and(
          sql`${memoryAlerts.daemonId} IN (${sql.join(daemonIds.map(id => sql`${id}`), sql`, `)})`,
          eq(memoryAlerts.acknowledged, false)
        )
      )
      .limit(10);

    // Calculate health score
    let healthScore = 100;
    const issues: Array<{ severity: string; message: string }> = [];
    const recommendations: string[] = [];

    // Deduct for OOM crashes
    const oomCrashes = crashes24h.filter(c => c.likelyCause === 'oom').length;
    if (oomCrashes > 0) {
      healthScore -= oomCrashes * 15;
      issues.push({
        severity: 'critical',
        message: `${oomCrashes} out-of-memory crash${oomCrashes > 1 ? 'es' : ''} in last 24 hours`,
      });
      recommendations.push('Increase memory limits or optimize agent memory usage');
    }

    // Deduct for memory leak crashes
    const leakCrashes = crashes24h.filter(c => c.likelyCause === 'memory_leak').length;
    if (leakCrashes > 0) {
      healthScore -= leakCrashes * 10;
      issues.push({
        severity: 'high',
        message: `${leakCrashes} likely memory leak crash${leakCrashes > 1 ? 'es' : ''} detected`,
      });
      recommendations.push('Investigate agents for memory leaks');
    }

    // Deduct for other crashes
    const otherCrashes = crashes24h.length - oomCrashes - leakCrashes;
    if (otherCrashes > 0) {
      healthScore -= otherCrashes * 5;
      issues.push({
        severity: 'medium',
        message: `${otherCrashes} other crash${otherCrashes > 1 ? 'es' : ''} in last 24 hours`,
      });
    }

    // Deduct for pending critical alerts
    const criticalAlerts = pendingAlerts.filter(a =>
      a.alertType === 'critical' || a.alertType === 'oom_imminent'
    ).length;
    if (criticalAlerts > 0) {
      healthScore -= criticalAlerts * 8;
      issues.push({
        severity: 'high',
        message: `${criticalAlerts} unacknowledged critical alert${criticalAlerts > 1 ? 's' : ''}`,
      });
      recommendations.push('Review and acknowledge pending alerts');
    }

    // Clamp health score
    healthScore = Math.max(0, Math.min(100, healthScore));

    // Generate summary
    let summary: string;
    if (healthScore >= 90) {
      summary = 'System is healthy. All agents operating normally.';
    } else if (healthScore >= 70) {
      summary = 'Some issues detected. Review warnings and recommendations.';
    } else if (healthScore >= 50) {
      summary = 'Multiple issues detected. Action recommended.';
    } else {
      summary = 'Critical issues detected. Immediate action required.';
    }

    res.json({
      healthScore,
      summary,
      issues: issues.sort((a, b) => {
        const order = { critical: 0, high: 1, medium: 2, low: 3 };
        return (order[a.severity as keyof typeof order] || 4) - (order[b.severity as keyof typeof order] || 4);
      }),
      recommendations,
      stats: {
        crashes24h: crashes24h.length,
        crashes7d: crashes7d.length,
        pendingAlerts: pendingAlerts.length,
        connectedDaemons: daemons.filter(d => d.status === 'online').length,
        totalDaemons: daemons.length,
      },
    });
  } catch (error) {
    console.error('Error fetching insights:', error);
    res.status(500).json({ error: 'Failed to fetch insights' });
  }
});
