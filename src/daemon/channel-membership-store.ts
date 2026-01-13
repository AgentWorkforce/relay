import { Pool } from 'pg';
import { createLogger } from '../utils/logger.js';

const log = createLogger('channel-membership-store');

export interface ChannelMembershipRecord {
  channel: string;
  member: string;
}

export interface ChannelMembershipStore {
  loadMemberships(): Promise<ChannelMembershipRecord[]>;
  addMember(channel: string, member: string): Promise<void>;
  removeMember(channel: string, member: string): Promise<void>;
}

export interface CloudChannelMembershipStoreOptions {
  workspaceId: string;
  databaseUrl: string;
}

/**
 * Cloud-backed membership store that uses the channel_members table in Postgres.
 * This is used by the daemon when running in a cloud workspace so membership
 * survives restarts and is shared across processes.
 */
export class CloudChannelMembershipStore implements ChannelMembershipStore {
  private workspaceId: string;
  private pool: Pool;

  constructor(options: CloudChannelMembershipStoreOptions) {
    this.workspaceId = options.workspaceId;
    this.pool = new Pool({
      connectionString: options.databaseUrl,
      ssl: options.databaseUrl.includes('sslmode=require')
        ? { rejectUnauthorized: false }
        : undefined,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }

  /**
   * Load all memberships for the workspace from Postgres.
   */
  async loadMemberships(): Promise<ChannelMembershipRecord[]> {
    try {
      const result = await this.pool.query(
        `
          SELECT c.channel_id AS channel_id, cm.member_id AS member_id
          FROM channel_members cm
          INNER JOIN channels c ON cm.channel_id = c.id
          WHERE c.workspace_id = $1 AND c.status != 'archived'
        `,
        [this.workspaceId],
      );

      return result.rows
        .map((row) => ({
          channel: this.formatChannelId(row.channel_id as string | null),
          member: row.member_id as string | null,
        }))
        .filter((row): row is ChannelMembershipRecord => Boolean(row.channel && row.member));
    } catch (err) {
      log.error('Failed to load channel memberships from cloud DB', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Add a member to a channel in Postgres (no-op if already present).
   */
  async addMember(channel: string, member: string): Promise<void> {
    const normalized = this.normalizeChannelId(channel);
    if (!normalized) {
      return;
    }

    const channelRowId = await this.getChannelRowId(normalized);
    if (!channelRowId) {
      return;
    }

    try {
      await this.pool.query(
        `
          INSERT INTO channel_members (channel_id, member_id, member_type, role)
          VALUES ($1, $2, 'agent', 'member')
          ON CONFLICT (channel_id, member_id) DO NOTHING
        `,
        [channelRowId, member],
      );
    } catch (err) {
      log.error('Failed to add channel member in cloud DB', {
        channel: normalized,
        member,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Remove a member from a channel in Postgres.
   */
  async removeMember(channel: string, member: string): Promise<void> {
    const normalized = this.normalizeChannelId(channel);
    if (!normalized) {
      return;
    }

    const channelRowId = await this.getChannelRowId(normalized);
    if (!channelRowId) {
      return;
    }

    try {
      await this.pool.query(
        'DELETE FROM channel_members WHERE channel_id = $1 AND member_id = $2',
        [channelRowId, member],
      );
    } catch (err) {
      log.error('Failed to remove channel member in cloud DB', {
        channel: normalized,
        member,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Normalize channel name for DB lookups (strip leading '#' and ignore DMs).
   */
  private normalizeChannelId(channel: string | null | undefined): string | null {
    if (!channel) return null;
    if (channel.startsWith('dm:')) {
      return null; // DM channels are not stored in channel_members
    }
    return channel.startsWith('#') ? channel.slice(1) : channel;
  }

  /**
   * Convert DB channel_id to router/channel format (prepend '#').
   */
  private formatChannelId(channelId: string | null): string {
    if (!channelId) return '';
    if (channelId.startsWith('#') || channelId.startsWith('dm:')) {
      return channelId;
    }
    return `#${channelId}`;
  }

  /**
   * Look up the channel row ID for a workspace/channel_id combination.
   */
  private async getChannelRowId(channelId: string): Promise<string | null> {
    try {
      const result = await this.pool.query(
        `
          SELECT id FROM channels
          WHERE workspace_id = $1 AND channel_id = $2
          LIMIT 1
        `,
        [this.workspaceId, channelId],
      );
      if (!result.rows[0]?.id) {
        log.warn('Channel not found in cloud DB for membership update', {
          workspaceId: this.workspaceId,
          channelId,
        });
        return null;
      }
      return result.rows[0].id as string;
    } catch (err) {
      log.error('Failed to look up channel row in cloud DB', {
        channelId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}
