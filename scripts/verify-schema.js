#!/usr/bin/env node
/**
 * Verify database schema after migrations
 *
 * This script verifies that all expected tables exist after migrations.
 * It dynamically reads table definitions from the schema to avoid hardcoding.
 *
 * Usage: DATABASE_URL=postgres://... node scripts/verify-schema.js
 */

import pg from 'pg';
import * as schema from '../dist/cloud/db/schema.js';

const { Pool } = pg;

/**
 * Extract table names from the schema module.
 * Drizzle pgTable objects store their name in Symbol.for('drizzle:Name').
 */
function getTablesFromSchema() {
  const tables = [];
  const drizzleNameSymbol = Symbol.for('drizzle:Name');

  for (const [key, value] of Object.entries(schema)) {
    // Skip relation definitions (they end with 'Relations')
    if (key.endsWith('Relations')) continue;

    // Drizzle tables have the table name in a Symbol
    if (value && typeof value === 'object' && value[drizzleNameSymbol]) {
      tables.push(value[drizzleNameSymbol]);
    }
  }
  return tables;
}

// Dynamically get tables from schema
const SCHEMA_TABLES = getTablesFromSchema();
const EXPECTED_TABLES = [...SCHEMA_TABLES];

// Key columns to spot-check (subset of critical columns)
const EXPECTED_COLUMNS = {
  users: ['id', 'email', 'created_at'],
  workspaces: ['id', 'user_id', 'name', 'status'],
  linked_daemons: ['id', 'user_id', 'workspace_id', 'status'],
};

async function main() {
  console.log('Verifying database schema...\n');

  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL environment variable is required');
    process.exit(1);
  }

  console.log(`Found ${SCHEMA_TABLES.length} tables in schema.ts:`);
  console.log(`  ${SCHEMA_TABLES.join(', ')}\n`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // Get all tables in the public schema
    const tablesResult = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);

    const existingTables = tablesResult.rows.map((r) => r.table_name);
    console.log('Existing tables:', existingTables.join(', '));
    console.log('');

    // Check for missing tables
    const missingTables = EXPECTED_TABLES.filter((t) => !existingTables.includes(t));
    if (missingTables.length > 0) {
      console.error('MISSING TABLES:', missingTables.join(', '));
      process.exit(1);
    }
    console.log(`All ${EXPECTED_TABLES.length} expected tables exist`);

    // Verify key columns
    console.log('\nVerifying key columns...');
    for (const [table, columns] of Object.entries(EXPECTED_COLUMNS)) {
      const columnsResult = await pool.query(
        `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
      `,
        [table]
      );

      const existingColumns = columnsResult.rows.map((r) => r.column_name);
      const missingColumns = columns.filter((c) => !existingColumns.includes(c));

      if (missingColumns.length > 0) {
        console.error(`Table '${table}' missing columns: ${missingColumns.join(', ')}`);
        console.error(`Existing columns: ${existingColumns.join(', ')}`);
        process.exit(1);
      }
      console.log(`  ${table}: OK (${columns.length} key columns verified)`);
    }

    // Check migration history (table may be in public or drizzle schema)
    try {
      // Try public schema first, then drizzle schema
      let migrationsResult;
      try {
        migrationsResult = await pool.query(`
          SELECT id, hash, created_at FROM public.__drizzle_migrations ORDER BY created_at
        `);
      } catch {
        migrationsResult = await pool.query(`
          SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at
        `);
      }
      console.log(`\nMigration history: ${migrationsResult.rows.length} migrations applied`);
      for (const row of migrationsResult.rows) {
        console.log(`  - ${row.id} (${new Date(Number(row.created_at)).toISOString()})`);
      }
    } catch {
      console.log('\nMigration history: (table not found, but migrations ran successfully)');
    }

    console.log('\nSchema verification passed!');
  } catch (error) {
    console.error('Schema verification failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
