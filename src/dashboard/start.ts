#!/usr/bin/env node
/**
 * Standalone dashboard starter for local development
 */

import { startDashboard } from './server.js';
import { getProjectPaths } from '../utils/project-namespace.js';

const port = parseInt(process.env.DASHBOARD_PORT || '3888', 10);
const paths = getProjectPaths();

console.log(`Starting dashboard for project: ${paths.projectRoot}`);
console.log(`Data dir: ${paths.dataDir}`);
console.log(`Database: ${paths.dbPath}`);

startDashboard(port, paths.dataDir, paths.teamDir, paths.dbPath).catch(console.error);
