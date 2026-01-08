#!/usr/bin/env node
/**
 * Run database migrations (standalone)
 *
 * This script is used in CI to verify migrations run successfully.
 * It connects to the database and runs all pending migrations.
 *
 * This is a standalone script that doesn't depend on the cloud config,
 * so it only requires DATABASE_URL to run.
 *
 * Usage: DATABASE_URL=postgres://... node scripts/run-migrations.js
 */

import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

const { Pool } = pg;

async function main() {
  console.log('Starting database migrations...');
  console.log(`Database URL: ${process.env.DATABASE_URL?.replace(/:[^:@]+@/, ':***@') || 'not set'}`);

  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL environment variable is required');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);

  try {
    await migrate(db, { migrationsFolder: './src/cloud/db/migrations' });
    console.log('All migrations completed successfully');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
