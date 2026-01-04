---
paths:
  - "src/cloud/db/**/*.ts"
  - "src/cloud/db/migrations/**/*.sql"
  - "drizzle.config.ts"
---

# Database Migration Conventions

## Drizzle ORM Migration Workflow

This project uses Drizzle ORM with PostgreSQL. Migrations run automatically on server startup via `runMigrations()`.

## When Schema Changes

After modifying `src/cloud/db/schema.ts`:

1. **Generate migration**: `npm run db:generate`
2. **Review the generated SQL** in `src/cloud/db/migrations/`
3. **Verify it's incremental** - should only contain ALTER/CREATE statements for changes, NOT recreate entire schema
4. **Test locally**: Restart server or run `npm run db:migrate`

## Common Issues

### Full Schema Recreation Instead of Incremental

If `db:generate` creates a migration that recreates all tables:

1. **Delete the bad migration file** from `migrations/`
2. **Remove its entry** from `migrations/meta/_journal.json`
3. **Delete any corrupt snapshot** in `migrations/meta/`
4. **Create incremental migration manually** using `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`

### Migration Not Applied

If schema has columns that aren't in the database:

1. Check if migration file exists in `migrations/`
2. Check if entry exists in `migrations/meta/_journal.json`
3. Verify migration ran: check `__drizzle_migrations` table in database

## Writing Safe Migrations

```sql
-- Use IF NOT EXISTS for idempotent migrations
ALTER TABLE users ADD COLUMN IF NOT EXISTS new_column VARCHAR(255);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_users_new_column ON users(new_column);
```

## Commands Reference

```bash
npm run db:generate   # Generate migration from schema diff
npm run db:migrate    # Run pending migrations
npm run db:push       # Push schema directly (dev only, can lose data)
npm run db:studio     # Open Drizzle Studio GUI
```

## Production Safety

- Always use `IF NOT EXISTS` / `IF EXISTS` for idempotent migrations
- Never use `db:push` in production - it can drop columns
- Test migrations on a copy of production data before deploying
- Migrations run on server startup - ensure they're fast and safe

## Migration File Naming

Files are named `NNNN_description.sql` where NNNN is sequential:
- `0001_initial.sql`
- `0002_add_feature.sql`
- `0003_nango_user_columns.sql`

The `_journal.json` tracks which migrations have been applied.
