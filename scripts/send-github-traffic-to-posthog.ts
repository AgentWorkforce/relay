/**
 * Send GitHub Traffic Stats to PostHog
 * 
 * Fetches daily traffic stats from GitHub API and records them in PostHog.
 * This script is designed to be run by the workflow.
 */

import { PostHog } from 'posthog-node';
import { getPostHogConfig } from '../packages/telemetry/src/posthog-config.js';

interface TrafficDataPoint {
  timestamp: string;
  count: number;
  uniques: number;
}

interface TrafficResponse {
  count: number;
  uniques: number;
  views?: TrafficDataPoint[];
  clones?: TrafficDataPoint[];
}

function parseTrafficData(jsonString: string): TrafficResponse {
  try {
    // Strip any leading text before the JSON object
    const jsonStart = jsonString.indexOf('{');
    const jsonEnd = jsonString.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) {
      throw new Error('No valid JSON found in output');
    }
    const cleanJson = jsonString.substring(jsonStart, jsonEnd + 1);
    return JSON.parse(cleanJson);
  } catch (error) {
    console.error('Failed to parse traffic data:', error);
    console.error('Raw output:', jsonString);
    throw error;
  }
}

async function sendToPostHog(viewsData: TrafficResponse, clonesData: TrafficResponse): Promise<void> {
  const config = getPostHogConfig();
  if (!config) {
    console.error('PostHog config not found. Set POSTHOG_API_KEY or configure in posthog-config.ts');
    process.exit(1);
  }

  console.log('Initializing PostHog client...');
  const client = new PostHog(config.apiKey, {
    host: config.host,
    flushAt: 1,
    flushInterval: 1000,
  });

  // Use a consistent distinct ID for the repo
  const distinctId = 'github-repo:AgentWorkforce/relay';

  // Combine views and clones by date
  const viewsByDate = new Map<string, TrafficDataPoint>();
  const clonesByDate = new Map<string, TrafficDataPoint>();

  viewsData.views?.forEach((v) => viewsByDate.set(v.timestamp, v));
  clonesData.clones?.forEach((c) => clonesByDate.set(c.timestamp, c));

  // Get all unique dates
  const allDates = new Set([...viewsByDate.keys(), ...clonesByDate.keys()]);

  console.log(`Sending ${allDates.size} daily traffic records to PostHog...`);

  // Send one event per day
  for (const date of allDates) {
    const views = viewsByDate.get(date) || { timestamp: date, count: 0, uniques: 0 };
    const clones = clonesByDate.get(date) || { timestamp: date, count: 0, uniques: 0 };

    client.capture({
      distinctId,
      event: 'github_traffic_daily',
      properties: {
        date,
        views_count: views.count,
        views_uniques: views.uniques,
        clones_count: clones.count,
        clones_uniques: clones.uniques,
        repo: 'AgentWorkforce/relay',
        metric_type: 'daily_traffic',
      },
    });

    console.log(`  ✓ ${date}: ${views.count} views (${views.uniques} unique), ${clones.count} clones (${clones.uniques} unique)`);
  }

  // Flush and shutdown
  console.log('Flushing events to PostHog...');
  await client.flush();
  await client.shutdown();
  console.log('POSTHOG_SEND_COMPLETE');
}

// Main execution
const viewsOutput = process.env.VIEWS_DATA;
const clonesOutput = process.env.CLONES_DATA;

if (!viewsOutput || !clonesOutput) {
  console.error('Missing VIEWS_DATA or CLONES_DATA environment variables');
  console.error('This script should be run by the workflow which provides these variables');
  process.exit(1);
}

try {
  const viewsData = parseTrafficData(viewsOutput);
  const clonesData = parseTrafficData(clonesOutput);
  
  console.log('Parsed traffic data:');
  console.log(`  Views: ${viewsData.count} total, ${viewsData.uniques} unique, ${viewsData.views?.length || 0} days`);
  console.log(`  Clones: ${clonesData.count} total, ${clonesData.uniques} unique, ${clonesData.clones?.length || 0} days`);
  
  await sendToPostHog(viewsData, clonesData);
} catch (error) {
  console.error('Error sending traffic stats to PostHog:', error);
  process.exit(1);
}
