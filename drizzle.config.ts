import type { Config } from 'drizzle-kit';
import 'dotenv/config';

export default {
  schema: './src/cloud/db/schema.ts',
  out: './src/cloud/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'postgres://agent_relay:dev_password@localhost:5432/agent_relay',
  },
  verbose: true,
  strict: true,
} satisfies Config;
