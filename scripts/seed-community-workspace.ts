#!/usr/bin/env node
/**
 * Seed script to create the public community workspace
 * 
 * This creates a public workspace that any logged-in user can join.
 * It's intended to contain always-on AI agents (DocsBot, HelpBot, RoadmapBot).
 * 
 * Usage:
 *   npm run seed:community-workspace
 *   or
 *   ADMIN_API_SECRET=secret node scripts/seed-community-workspace.ts
 */

// Note: This script should be run after building the cloud package
// Run: npm run build:cloud && node --loader ts-node/esm scripts/seed-community-workspace.ts
// Or compile first: npx tsc scripts/seed-community-workspace.ts && node scripts/seed-community-workspace.js

import { getConfig } from '../packages/cloud/src/config.js';
import { getDb } from '../packages/cloud/src/db/drizzle.js';
import { getProvisioner } from '../packages/cloud/src/provisioner/index.js';

async function seedCommunityWorkspace() {
  const config = getConfig();
  const db = getDb();
  const provisioner = getProvisioner();

  // Find or create a system user for the community workspace
  // In production, this should be a dedicated system account
  const systemUser = await db.users.findByGithubUsername('agent-relay');
  
  if (!systemUser) {
    console.error('System user "agent-relay" not found. Please create a system account first.');
    console.error('This workspace needs an owner. You can:');
    console.error('1. Create a GitHub account named "agent-relay"');
    console.error('2. Sign up with that account on Agent Relay');
    console.error('3. Run this script again');
    process.exit(1);
  }

  // Check if community workspace already exists
  const existingWorkspaces = await db.workspaces.findByUserId(systemUser.id);
  const communityWorkspace = existingWorkspaces.find(w => w.name === 'Community' || w.name === 'community');

  if (communityWorkspace) {
    if (communityWorkspace.isPublic) {
      console.log(`✓ Community workspace already exists: ${communityWorkspace.id}`);
      console.log(`  Name: ${communityWorkspace.name}`);
      console.log(`  Status: ${communityWorkspace.status}`);
      console.log(`  Public URL: ${communityWorkspace.publicUrl || 'Not available'}`);
      return;
    } else {
      // Make it public
      console.log('Making existing workspace public...');
      await db.workspaces.update(communityWorkspace.id, { isPublic: true });
      console.log(`✓ Updated workspace ${communityWorkspace.id} to be public`);
      return;
    }
  }

  console.log('Creating community workspace...');
  console.log(`  Owner: ${systemUser.githubUsername} (${systemUser.id})`);

  // Create the community workspace
  // Note: This requires at least one provider and repository
  // For a public community workspace, we'll use minimal config
  const result = await provisioner.provision({
    userId: systemUser.id,
    name: 'Community',
    providers: ['claude'], // Default provider
    repositories: [], // No repos needed for community workspace
    supervisorEnabled: true,
    maxAgents: 10,
    isPublic: true,
  });

  if (result.status === 'error') {
    console.error('Failed to create community workspace:', result.error);
    process.exit(1);
  }

  console.log(`✓ Community workspace created: ${result.workspaceId}`);
  console.log(`  Status: ${result.status}`);
  console.log(`  Public URL: ${result.publicUrl || 'Will be available after provisioning'}`);
  console.log('');
  console.log('Next steps:');
  console.log('1. Wait for workspace to finish provisioning');
  console.log('2. Deploy AI agents (DocsBot, HelpBot, RoadmapBot) via bd-agent-public-001');
  console.log('3. Users can now join via POST /api/workspaces/:id/join');
}

seedCommunityWorkspace().catch((error) => {
  console.error('Error seeding community workspace:', error);
  process.exit(1);
});
