/**
 * Channels API Routes
 *
 * CRUD operations for workspace channels.
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from './auth.js';
import { db, ChannelMemberRole, ChannelMemberType, Channel } from '../db/index.js';

export const channelsRouter = Router();

// All routes require authentication
channelsRouter.use(requireAuth);

// ============================================================================
// Validation helpers
// ============================================================================

/**
 * Validate channel name format.
 * Rules: 1-80 characters, lowercase alphanumeric and dashes only.
 */
function validateChannelName(name: string): { valid: boolean; error?: string } {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: 'Channel name is required' };
  }

  const trimmed = name.trim().toLowerCase();

  if (trimmed.length < 1 || trimmed.length > 80) {
    return { valid: false, error: 'Channel name must be 1-80 characters' };
  }

  if (!/^[a-z0-9-]+$/.test(trimmed)) {
    return { valid: false, error: 'Channel name can only contain lowercase letters, numbers, and dashes' };
  }

  if (trimmed.startsWith('-') || trimmed.endsWith('-')) {
    return { valid: false, error: 'Channel name cannot start or end with a dash' };
  }

  return { valid: true };
}

/**
 * Check if user can manage channels in workspace (create, update, delete).
 */
async function canManageChannels(workspaceId: string, userId: string): Promise<boolean> {
  const canEdit = await db.workspaceMembers.canEdit(workspaceId, userId);
  if (canEdit) return true;

  // Also check if user is the workspace owner
  const workspace = await db.workspaces.findById(workspaceId);
  return workspace?.userId === userId;
}

/**
 * Check if user can view workspace.
 */
async function canViewWorkspace(workspaceId: string, userId: string): Promise<boolean> {
  const canView = await db.workspaceMembers.canView(workspaceId, userId);
  if (canView) return true;

  // Also check if user is the workspace owner
  const workspace = await db.workspaces.findById(workspaceId);
  return workspace?.userId === userId;
}

/**
 * Check if user is channel admin.
 */
async function isChannelAdmin(channelId: string, userId: string): Promise<boolean> {
  const membership = await db.channelMembers.findMembership(channelId, userId, 'user');
  return membership?.role === 'admin';
}

// ============================================================================
// Channel CRUD Routes
// ============================================================================

/**
 * GET /api/workspaces/:workspaceId/channels
 * List channels in a workspace
 */
channelsRouter.get('/workspaces/:workspaceId/channels', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { workspaceId } = req.params;
  const { includeArchived } = req.query;

  try {
    // Check user has access to workspace
    if (!(await canViewWorkspace(workspaceId, userId))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const channels = await db.channels.findByWorkspaceId(workspaceId, {
      includeArchived: includeArchived === 'true',
    });

    // Filter private channels to only those user is a member of
    const visibleChannels = await Promise.all(
      channels.map(async (channel): Promise<Channel | null> => {
        if (!channel.isPrivate) return channel;
        const isMember = await db.channelMembers.isMember(channel.id, userId, 'user');
        return isMember ? channel : null;
      })
    );

    // Filter out nulls
    const filteredChannels = visibleChannels.filter(
      (c: Channel | null): c is Channel => c !== null
    );

    // Get unread counts for all visible channels in one batch
    const channelIds = filteredChannels.map((c: Channel) => c.id);
    const unreadCounts = await db.channelReadState.getUnreadCountsForUser(userId, channelIds);

    res.json({
      channels: filteredChannels.map((c: Channel) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        topic: c.topic,
        isPrivate: c.isPrivate,
        isArchived: c.isArchived,
        memberCount: c.memberCount,
        lastActivityAt: c.lastActivityAt,
        createdAt: c.createdAt,
        unreadCount: unreadCounts.get(c.id) ?? 0,
        hasMentions: false, // TODO: Implement mention tracking in Task 6
      })),
    });
  } catch (error) {
    console.error('Error listing channels:', error);
    res.status(500).json({ error: 'Failed to list channels' });
  }
});

/**
 * GET /api/workspaces/:workspaceId/channels/:channelId
 * Get channel details
 */
channelsRouter.get('/workspaces/:workspaceId/channels/:channelId', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { workspaceId, channelId } = req.params;

  try {
    // Check user has access to workspace
    if (!(await canViewWorkspace(workspaceId, userId))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const channel = await db.channels.findById(channelId);
    if (!channel || channel.workspaceId !== workspaceId) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Check access for private channels
    if (channel.isPrivate) {
      const isMember = await db.channelMembers.isMember(channelId, userId, 'user');
      if (!isMember) {
        return res.status(403).json({ error: 'Access denied to private channel' });
      }
    }

    // Get user's membership in this channel
    const membership = await db.channelMembers.findMembership(channelId, userId, 'user');

    // Get unread count for this channel
    const unreadCount = await db.channelReadState.getUnreadCount(channelId, userId);

    res.json({
      channel: {
        id: channel.id,
        name: channel.name,
        description: channel.description,
        topic: channel.topic,
        isPrivate: channel.isPrivate,
        isArchived: channel.isArchived,
        memberCount: channel.memberCount,
        lastActivityAt: channel.lastActivityAt,
        createdById: channel.createdById,
        createdAt: channel.createdAt,
        updatedAt: channel.updatedAt,
        unreadCount,
        hasMentions: false, // TODO: Implement mention tracking in Task 6
      },
      membership: membership
        ? {
            role: membership.role,
            joinedAt: membership.joinedAt,
          }
        : null,
    });
  } catch (error) {
    console.error('Error getting channel:', error);
    res.status(500).json({ error: 'Failed to get channel' });
  }
});

/**
 * POST /api/workspaces/:workspaceId/channels
 * Create a new channel
 */
channelsRouter.post('/workspaces/:workspaceId/channels', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { workspaceId } = req.params;
  const { name, description, isPrivate = false } = req.body;

  try {
    // Check user can manage channels
    if (!(await canManageChannels(workspaceId, userId))) {
      return res.status(403).json({ error: 'You do not have permission to create channels' });
    }

    // Validate channel name
    const validation = validateChannelName(name);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    const normalizedName = name.trim().toLowerCase();

    // Check for duplicate name
    const existing = await db.channels.findByName(workspaceId, normalizedName);
    if (existing) {
      return res.status(409).json({ error: 'A channel with this name already exists' });
    }

    // Create channel
    const channel = await db.channels.create({
      workspaceId,
      name: normalizedName,
      description: description?.trim() || null,
      isPrivate: Boolean(isPrivate),
      createdById: userId,
    });

    // Add creator as admin member
    await db.channelMembers.addMember({
      channelId: channel.id,
      entityId: userId,
      entityType: 'user',
      role: 'admin',
    });

    // Increment member count
    await db.channels.incrementMemberCount(channel.id);

    res.status(201).json({
      channel: {
        id: channel.id,
        name: channel.name,
        description: channel.description,
        isPrivate: channel.isPrivate,
        isArchived: channel.isArchived,
        memberCount: 1,
        createdAt: channel.createdAt,
      },
    });
  } catch (error) {
    console.error('Error creating channel:', error);
    res.status(500).json({ error: 'Failed to create channel' });
  }
});

/**
 * PATCH /api/workspaces/:workspaceId/channels/:channelId
 * Update channel details
 */
channelsRouter.patch('/workspaces/:workspaceId/channels/:channelId', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { workspaceId, channelId } = req.params;
  const { name, description, isPrivate } = req.body;

  try {
    const channel = await db.channels.findById(channelId);
    if (!channel || channel.workspaceId !== workspaceId) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Check permissions - must be channel admin or workspace admin
    const isChAdmin = await isChannelAdmin(channelId, userId);
    const canManage = await canManageChannels(workspaceId, userId);
    if (!isChAdmin && !canManage) {
      return res.status(403).json({ error: 'You do not have permission to update this channel' });
    }

    // Build update object
    const updates: Partial<{ name: string; description: string | null; isPrivate: boolean }> = {};

    if (name !== undefined) {
      const validation = validateChannelName(name);
      if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
      }
      const normalizedName = name.trim().toLowerCase();

      // Check for duplicate if name is changing
      if (normalizedName !== channel.name) {
        const existing = await db.channels.findByName(workspaceId, normalizedName);
        if (existing) {
          return res.status(409).json({ error: 'A channel with this name already exists' });
        }
      }
      updates.name = normalizedName;
    }

    if (description !== undefined) {
      updates.description = description?.trim() || null;
    }

    if (isPrivate !== undefined) {
      updates.isPrivate = Boolean(isPrivate);
    }

    if (Object.keys(updates).length > 0) {
      await db.channels.update(channelId, updates);
    }

    const updated = await db.channels.findById(channelId);

    res.json({
      channel: {
        id: updated!.id,
        name: updated!.name,
        description: updated!.description,
        isPrivate: updated!.isPrivate,
        isArchived: updated!.isArchived,
        memberCount: updated!.memberCount,
        updatedAt: updated!.updatedAt,
      },
    });
  } catch (error) {
    console.error('Error updating channel:', error);
    res.status(500).json({ error: 'Failed to update channel' });
  }
});

/**
 * POST /api/workspaces/:workspaceId/channels/:channelId/archive
 * Archive a channel
 */
channelsRouter.post('/workspaces/:workspaceId/channels/:channelId/archive', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { workspaceId, channelId } = req.params;

  try {
    const channel = await db.channels.findById(channelId);
    if (!channel || channel.workspaceId !== workspaceId) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Only channel admins or workspace admins can archive
    const isChAdmin = await isChannelAdmin(channelId, userId);
    const canManage = await canManageChannels(workspaceId, userId);
    if (!isChAdmin && !canManage) {
      return res.status(403).json({ error: 'You do not have permission to archive this channel' });
    }

    if (channel.isArchived) {
      return res.status(400).json({ error: 'Channel is already archived' });
    }

    await db.channels.archive(channelId);

    res.json({ success: true, isArchived: true });
  } catch (error) {
    console.error('Error archiving channel:', error);
    res.status(500).json({ error: 'Failed to archive channel' });
  }
});

/**
 * POST /api/workspaces/:workspaceId/channels/:channelId/unarchive
 * Unarchive a channel
 */
channelsRouter.post('/workspaces/:workspaceId/channels/:channelId/unarchive', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { workspaceId, channelId } = req.params;

  try {
    const channel = await db.channels.findById(channelId);
    if (!channel || channel.workspaceId !== workspaceId) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Only channel admins or workspace admins can unarchive
    const isChAdmin = await isChannelAdmin(channelId, userId);
    const canManage = await canManageChannels(workspaceId, userId);
    if (!isChAdmin && !canManage) {
      return res.status(403).json({ error: 'You do not have permission to unarchive this channel' });
    }

    if (!channel.isArchived) {
      return res.status(400).json({ error: 'Channel is not archived' });
    }

    await db.channels.unarchive(channelId);

    res.json({ success: true, isArchived: false });
  } catch (error) {
    console.error('Error unarchiving channel:', error);
    res.status(500).json({ error: 'Failed to unarchive channel' });
  }
});

/**
 * DELETE /api/workspaces/:workspaceId/channels/:channelId
 * Delete a channel permanently
 */
channelsRouter.delete('/workspaces/:workspaceId/channels/:channelId', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { workspaceId, channelId } = req.params;

  try {
    const channel = await db.channels.findById(channelId);
    if (!channel || channel.workspaceId !== workspaceId) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Only workspace admins can delete channels (not just channel admins)
    const canManage = await canManageChannels(workspaceId, userId);
    const workspace = await db.workspaces.findById(workspaceId);
    const isOwner = workspace?.userId === userId;

    // Require workspace owner or admin for deletion
    if (!isOwner) {
      const membership = await db.workspaceMembers.findMembership(workspaceId, userId);
      if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
        return res.status(403).json({ error: 'Only workspace owners and admins can delete channels' });
      }
    }

    // Delete channel (cascades to members, messages, read state via FK)
    await db.channels.delete(channelId);

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting channel:', error);
    res.status(500).json({ error: 'Failed to delete channel' });
  }
});

// ============================================================================
// Channel Membership Routes
// ============================================================================

/**
 * GET /api/workspaces/:workspaceId/channels/:channelId/members
 * List channel members
 */
channelsRouter.get('/workspaces/:workspaceId/channels/:channelId/members', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { workspaceId, channelId } = req.params;

  try {
    // Check user has access to workspace
    if (!(await canViewWorkspace(workspaceId, userId))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const channel = await db.channels.findById(channelId);
    if (!channel || channel.workspaceId !== workspaceId) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Check access for private channels
    if (channel.isPrivate) {
      const isMember = await db.channelMembers.isMember(channelId, userId, 'user');
      if (!isMember) {
        return res.status(403).json({ error: 'Access denied to private channel' });
      }
    }

    const members = await db.channelMembers.findByChannelId(channelId);

    // Enrich with user info for user members
    const enrichedMembers = await Promise.all(
      members.map(async (m) => {
        if (m.entityType === 'user') {
          const user = await db.users.findById(m.entityId);
          return {
            id: m.id,
            memberId: m.entityId,
            memberType: m.entityType,
            role: m.role,
            joinedAt: m.joinedAt,
            user: user
              ? {
                  githubUsername: user.githubUsername,
                  email: user.email ?? undefined,
                  avatarUrl: user.avatarUrl ?? undefined,
                }
              : undefined,
          };
        } else {
          // Agent member - just return basic info
          return {
            id: m.id,
            memberId: m.entityId,
            memberType: m.entityType,
            role: m.role,
            joinedAt: m.joinedAt,
          };
        }
      })
    );

    res.json({ members: enrichedMembers });
  } catch (error) {
    console.error('Error listing channel members:', error);
    res.status(500).json({ error: 'Failed to list channel members' });
  }
});

/**
 * POST /api/workspaces/:workspaceId/channels/:channelId/members
 * Add a member to channel
 */
channelsRouter.post('/workspaces/:workspaceId/channels/:channelId/members', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { workspaceId, channelId } = req.params;
  const { memberId, memberType = 'user', role = 'member' } = req.body;

  if (!memberId) {
    return res.status(400).json({ error: 'memberId is required' });
  }

  const validTypes: ChannelMemberType[] = ['user', 'agent'];
  if (!validTypes.includes(memberType)) {
    return res.status(400).json({ error: 'Invalid memberType. Must be user or agent' });
  }

  const validRoles: ChannelMemberRole[] = ['admin', 'member', 'read_only'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: 'Invalid role. Must be admin, member, or read_only' });
  }

  try {
    const channel = await db.channels.findById(channelId);
    if (!channel || channel.workspaceId !== workspaceId) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Check permissions - must be channel admin or workspace admin
    const isChAdmin = await isChannelAdmin(channelId, userId);
    const canManage = await canManageChannels(workspaceId, userId);
    if (!isChAdmin && !canManage) {
      return res.status(403).json({ error: 'You do not have permission to add members' });
    }

    // For user members, verify they exist and are in the workspace
    if (memberType === 'user') {
      const targetUser = await db.users.findById(memberId);
      if (!targetUser) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Check they're in the workspace
      const workspaceMembership = await db.workspaceMembers.findMembership(workspaceId, memberId);
      const workspace = await db.workspaces.findById(workspaceId);
      if (!workspaceMembership && workspace?.userId !== memberId) {
        return res.status(400).json({ error: 'User is not a member of this workspace' });
      }
    }

    // Check if already a member
    const existing = await db.channelMembers.findMembership(channelId, memberId, memberType);
    if (existing) {
      return res.status(409).json({ error: 'Already a member of this channel' });
    }

    // Add member
    const member = await db.channelMembers.addMember({
      channelId,
      entityId: memberId,
      entityType: memberType,
      role,
    });

    // Increment member count
    await db.channels.incrementMemberCount(channelId);

    res.status(201).json({
      member: {
        id: member.id,
        memberId: member.entityId,
        memberType: member.entityType,
        role: member.role,
        joinedAt: member.joinedAt,
      },
    });
  } catch (error) {
    console.error('Error adding channel member:', error);
    res.status(500).json({ error: 'Failed to add member' });
  }
});

/**
 * POST /api/workspaces/:workspaceId/channels/:channelId/join
 * Join a public channel (self-join)
 */
channelsRouter.post('/workspaces/:workspaceId/channels/:channelId/join', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { workspaceId, channelId } = req.params;

  try {
    // Check user has access to workspace
    if (!(await canViewWorkspace(workspaceId, userId))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const channel = await db.channels.findById(channelId);
    if (!channel || channel.workspaceId !== workspaceId) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Can only self-join public channels
    if (channel.isPrivate) {
      return res.status(403).json({ error: 'Cannot join private channels. Request an invite from an admin.' });
    }

    // Check if already a member
    const existing = await db.channelMembers.findMembership(channelId, userId, 'user');
    if (existing) {
      return res.status(409).json({ error: 'Already a member of this channel' });
    }

    // Add as regular member
    const member = await db.channelMembers.addMember({
      channelId,
      entityId: userId,
      entityType: 'user',
      role: 'member',
    });

    // Increment member count
    await db.channels.incrementMemberCount(channelId);

    res.status(201).json({
      success: true,
      member: {
        id: member.id,
        role: member.role,
        joinedAt: member.joinedAt,
      },
    });
  } catch (error) {
    console.error('Error joining channel:', error);
    res.status(500).json({ error: 'Failed to join channel' });
  }
});

/**
 * POST /api/workspaces/:workspaceId/channels/:channelId/leave
 * Leave a channel (self-remove)
 */
channelsRouter.post('/workspaces/:workspaceId/channels/:channelId/leave', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { workspaceId, channelId } = req.params;

  try {
    const channel = await db.channels.findById(channelId);
    if (!channel || channel.workspaceId !== workspaceId) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    const membership = await db.channelMembers.findMembership(channelId, userId, 'user');
    if (!membership) {
      return res.status(400).json({ error: 'Not a member of this channel' });
    }

    // Don't allow the last admin to leave
    if (membership.role === 'admin') {
      const members = await db.channelMembers.findByChannelId(channelId);
      const adminCount = members.filter((m) => m.role === 'admin').length;
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'Cannot leave: you are the last admin. Transfer ownership first.' });
      }
    }

    // Remove member
    await db.channelMembers.removeMember(channelId, userId, 'user');
    await db.channels.decrementMemberCount(channelId);

    res.json({ success: true });
  } catch (error) {
    console.error('Error leaving channel:', error);
    res.status(500).json({ error: 'Failed to leave channel' });
  }
});

/**
 * PATCH /api/workspaces/:workspaceId/channels/:channelId/members/:memberId
 * Update member role
 */
channelsRouter.patch('/workspaces/:workspaceId/channels/:channelId/members/:memberId', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { workspaceId, channelId, memberId } = req.params;
  const { role, memberType = 'user' } = req.body;

  const validTypes: ChannelMemberType[] = ['user', 'agent'];
  if (!validTypes.includes(memberType)) {
    return res.status(400).json({ error: 'Invalid memberType' });
  }

  const validRoles: ChannelMemberRole[] = ['admin', 'member', 'read_only'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  try {
    const channel = await db.channels.findById(channelId);
    if (!channel || channel.workspaceId !== workspaceId) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Only channel admins or workspace admins can change roles
    const isChAdmin = await isChannelAdmin(channelId, userId);
    const canManage = await canManageChannels(workspaceId, userId);
    if (!isChAdmin && !canManage) {
      return res.status(403).json({ error: 'You do not have permission to change roles' });
    }

    const membership = await db.channelMembers.findMembership(channelId, memberId, memberType);
    if (!membership) {
      return res.status(404).json({ error: 'Member not found' });
    }

    // Don't allow demoting the last admin
    if (membership.role === 'admin' && role !== 'admin') {
      const members = await db.channelMembers.findByChannelId(channelId);
      const adminCount = members.filter((m) => m.role === 'admin').length;
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'Cannot demote: this is the last admin' });
      }
    }

    await db.channelMembers.updateRole(channelId, memberId, memberType, role);

    res.json({ success: true, role });
  } catch (error) {
    console.error('Error updating member role:', error);
    res.status(500).json({ error: 'Failed to update role' });
  }
});

/**
 * DELETE /api/workspaces/:workspaceId/channels/:channelId/members/:memberId
 * Remove a member from channel
 */
channelsRouter.delete('/workspaces/:workspaceId/channels/:channelId/members/:memberId', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { workspaceId, channelId, memberId } = req.params;
  const { memberType = 'user' } = req.query;

  const validTypes: ChannelMemberType[] = ['user', 'agent'];
  if (!validTypes.includes(memberType as ChannelMemberType)) {
    return res.status(400).json({ error: 'Invalid memberType' });
  }

  try {
    const channel = await db.channels.findById(channelId);
    if (!channel || channel.workspaceId !== workspaceId) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Only channel admins or workspace admins can remove members
    const isChAdmin = await isChannelAdmin(channelId, userId);
    const canManage = await canManageChannels(workspaceId, userId);
    if (!isChAdmin && !canManage) {
      return res.status(403).json({ error: 'You do not have permission to remove members' });
    }

    const membership = await db.channelMembers.findMembership(channelId, memberId, memberType as ChannelMemberType);
    if (!membership) {
      return res.status(404).json({ error: 'Member not found' });
    }

    // Don't allow removing the last admin
    if (membership.role === 'admin') {
      const members = await db.channelMembers.findByChannelId(channelId);
      const adminCount = members.filter((m) => m.role === 'admin').length;
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'Cannot remove: this is the last admin' });
      }
    }

    await db.channelMembers.removeMember(channelId, memberId, memberType as ChannelMemberType);
    await db.channels.decrementMemberCount(channelId);

    res.json({ success: true });
  } catch (error) {
    console.error('Error removing channel member:', error);
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

// ============================================================================
// Channel Messages Routes (Task 4)
// ============================================================================

/**
 * GET /api/workspaces/:workspaceId/channels/:channelId/messages
 * Get messages in a channel with pagination
 */
channelsRouter.get('/workspaces/:workspaceId/channels/:channelId/messages', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { workspaceId, channelId } = req.params;
  const { before, limit = '50', threadId } = req.query;

  try {
    // Check user has access to workspace
    if (!(await canViewWorkspace(workspaceId, userId))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const channel = await db.channels.findById(channelId);
    if (!channel || channel.workspaceId !== workspaceId) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Check access for private channels
    if (channel.isPrivate) {
      const isMember = await db.channelMembers.isMember(channelId, userId, 'user');
      if (!isMember) {
        return res.status(403).json({ error: 'Access denied to private channel' });
      }
    }

    let messages;
    if (threadId) {
      // Get thread replies
      messages = await db.channelMessages.findThread(threadId as string);
    } else {
      // Get top-level messages
      messages = await db.channelMessages.findByChannelId(channelId, {
        limit: Math.min(parseInt(limit as string) || 50, 100),
        beforeId: before as string | undefined,
      });
    }

    // Get user's read state
    const readState = await db.channelReadState.findByChannelAndUser(channelId, userId);

    res.json({
      messages: messages.map((m) => ({
        id: m.id,
        channelId: m.channelId,
        from: m.senderName,
        fromId: m.senderId,
        fromEntityType: m.senderType,
        content: m.body,
        timestamp: m.createdAt.toISOString(),
        editedAt: m.updatedAt > m.createdAt ? m.updatedAt.toISOString() : undefined,
        threadId: m.threadId,
        replyCount: m.replyCount,
        isPinned: m.isPinned,
        isRead: readState ? m.createdAt <= readState.lastReadAt : true,
      })),
      hasMore: messages.length >= parseInt(limit as string),
      unread: readState
        ? {
            count: 0, // TODO: Calculate actual unread count
            lastReadTimestamp: readState.lastReadAt.toISOString(),
          }
        : { count: 0 },
    });
  } catch (error) {
    console.error('Error getting channel messages:', error);
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

/**
 * POST /api/workspaces/:workspaceId/channels/:channelId/messages
 * Send a message to a channel
 */
channelsRouter.post('/workspaces/:workspaceId/channels/:channelId/messages', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { workspaceId, channelId } = req.params;
  const { content, threadId } = req.body;

  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    return res.status(400).json({ error: 'Message content is required' });
  }

  try {
    const channel = await db.channels.findById(channelId);
    if (!channel || channel.workspaceId !== workspaceId) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Check if user can post (must be member with admin or member role)
    const canPost = await db.channelMembers.canPost(channelId, userId, 'user');
    if (!canPost) {
      return res.status(403).json({ error: 'You do not have permission to post in this channel' });
    }

    // Get user info for sender name
    const user = await db.users.findById(userId);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    // Validate thread if specified
    if (threadId) {
      const parentMessage = await db.channelMessages.findById(threadId);
      if (!parentMessage || parentMessage.channelId !== channelId) {
        return res.status(404).json({ error: 'Thread parent message not found' });
      }
    }

    // Create message
    const message = await db.channelMessages.create({
      channelId,
      senderId: userId,
      senderType: 'user',
      senderName: user.githubUsername || user.email || 'Unknown',
      body: content.trim(),
      threadId: threadId || null,
    });

    // If this is a thread reply, increment parent's reply count
    if (threadId) {
      await db.channelMessages.incrementReplyCount(threadId);
    }

    // Update channel's last activity
    await db.channels.updateLastActivity(channelId);

    res.status(201).json({
      message: {
        id: message.id,
        channelId: message.channelId,
        from: message.senderName,
        fromId: message.senderId,
        fromEntityType: message.senderType,
        content: message.body,
        timestamp: message.createdAt.toISOString(),
        threadId: message.threadId,
        replyCount: message.replyCount,
        isPinned: message.isPinned,
      },
    });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

/**
 * PATCH /api/workspaces/:workspaceId/channels/:channelId/messages/:messageId
 * Edit a message (only by sender)
 */
channelsRouter.patch('/workspaces/:workspaceId/channels/:channelId/messages/:messageId', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { workspaceId, channelId, messageId } = req.params;
  const { content } = req.body;

  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    return res.status(400).json({ error: 'Message content is required' });
  }

  try {
    const channel = await db.channels.findById(channelId);
    if (!channel || channel.workspaceId !== workspaceId) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    const message = await db.channelMessages.findById(messageId);
    if (!message || message.channelId !== channelId) {
      return res.status(404).json({ error: 'Message not found' });
    }

    // Only sender can edit their own message
    if (message.senderId !== userId || message.senderType !== 'user') {
      return res.status(403).json({ error: 'You can only edit your own messages' });
    }

    await db.channelMessages.update(messageId, { body: content.trim() });

    res.json({ success: true });
  } catch (error) {
    console.error('Error editing message:', error);
    res.status(500).json({ error: 'Failed to edit message' });
  }
});

/**
 * DELETE /api/workspaces/:workspaceId/channels/:channelId/messages/:messageId
 * Delete a message (by sender or channel admin)
 */
channelsRouter.delete('/workspaces/:workspaceId/channels/:channelId/messages/:messageId', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { workspaceId, channelId, messageId } = req.params;

  try {
    const channel = await db.channels.findById(channelId);
    if (!channel || channel.workspaceId !== workspaceId) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    const message = await db.channelMessages.findById(messageId);
    if (!message || message.channelId !== channelId) {
      return res.status(404).json({ error: 'Message not found' });
    }

    // Can delete if: owner of message OR channel admin
    const isOwner = message.senderId === userId && message.senderType === 'user';
    const isChAdmin = await isChannelAdmin(channelId, userId);

    if (!isOwner && !isChAdmin) {
      return res.status(403).json({ error: 'You do not have permission to delete this message' });
    }

    // If this is a thread reply, decrement parent's reply count
    if (message.threadId) {
      await db.channelMessages.decrementReplyCount(message.threadId);
    }

    await db.channelMessages.delete(messageId);

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting message:', error);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

/**
 * GET /api/workspaces/:workspaceId/channels/:channelId/messages/pinned
 * Get pinned messages in a channel
 */
channelsRouter.get('/workspaces/:workspaceId/channels/:channelId/messages/pinned', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { workspaceId, channelId } = req.params;

  try {
    // Check user has access to workspace
    if (!(await canViewWorkspace(workspaceId, userId))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const channel = await db.channels.findById(channelId);
    if (!channel || channel.workspaceId !== workspaceId) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Check access for private channels
    if (channel.isPrivate) {
      const isMember = await db.channelMembers.isMember(channelId, userId, 'user');
      if (!isMember) {
        return res.status(403).json({ error: 'Access denied to private channel' });
      }
    }

    const pinnedMessages = await db.channelMessages.findPinned(channelId);

    res.json({
      messages: pinnedMessages.map((m) => ({
        id: m.id,
        channelId: m.channelId,
        from: m.senderName,
        fromId: m.senderId,
        fromEntityType: m.senderType,
        content: m.body,
        timestamp: m.createdAt.toISOString(),
        pinnedAt: m.pinnedAt?.toISOString(),
        isPinned: true,
      })),
    });
  } catch (error) {
    console.error('Error getting pinned messages:', error);
    res.status(500).json({ error: 'Failed to get pinned messages' });
  }
});

/**
 * GET /api/workspaces/:workspaceId/channels/:channelId/messages/:threadId/thread
 * Get a thread (parent message + all replies)
 */
channelsRouter.get('/workspaces/:workspaceId/channels/:channelId/messages/:threadId/thread', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { workspaceId, channelId, threadId } = req.params;

  try {
    // Check user has access to workspace
    if (!(await canViewWorkspace(workspaceId, userId))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const channel = await db.channels.findById(channelId);
    if (!channel || channel.workspaceId !== workspaceId) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Check access for private channels
    if (channel.isPrivate) {
      const isMember = await db.channelMembers.isMember(channelId, userId, 'user');
      if (!isMember) {
        return res.status(403).json({ error: 'Access denied to private channel' });
      }
    }

    // Get the parent message
    const parentMessage = await db.channelMessages.findById(threadId);
    if (!parentMessage || parentMessage.channelId !== channelId) {
      return res.status(404).json({ error: 'Thread not found' });
    }

    // Get all replies in the thread
    const replies = await db.channelMessages.findThread(threadId);

    // Get user's read state
    const readState = await db.channelReadState.findByChannelAndUser(channelId, userId);

    const formatMessage = (m: typeof parentMessage) => ({
      id: m.id,
      channelId: m.channelId,
      from: m.senderName,
      fromId: m.senderId,
      fromEntityType: m.senderType,
      content: m.body,
      timestamp: m.createdAt.toISOString(),
      editedAt: m.updatedAt > m.createdAt ? m.updatedAt.toISOString() : undefined,
      threadId: m.threadId,
      replyCount: m.replyCount,
      isPinned: m.isPinned,
      isRead: readState ? m.createdAt <= readState.lastReadAt : true,
    });

    res.json({
      parent: formatMessage(parentMessage),
      replies: replies.map(formatMessage),
    });
  } catch (error) {
    console.error('Error getting thread:', error);
    res.status(500).json({ error: 'Failed to get thread' });
  }
});

/**
 * POST /api/workspaces/:workspaceId/channels/:channelId/messages/:messageId/pin
 * Pin a message
 */
channelsRouter.post('/workspaces/:workspaceId/channels/:channelId/messages/:messageId/pin', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { workspaceId, channelId, messageId } = req.params;

  try {
    const channel = await db.channels.findById(channelId);
    if (!channel || channel.workspaceId !== workspaceId) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    const message = await db.channelMessages.findById(messageId);
    if (!message || message.channelId !== channelId) {
      return res.status(404).json({ error: 'Message not found' });
    }

    // Only channel admins can pin
    const isChAdmin = await isChannelAdmin(channelId, userId);
    const canManage = await canManageChannels(workspaceId, userId);
    if (!isChAdmin && !canManage) {
      return res.status(403).json({ error: 'Only admins can pin messages' });
    }

    if (message.isPinned) {
      return res.status(400).json({ error: 'Message is already pinned' });
    }

    await db.channelMessages.pin(messageId, userId);

    res.json({ success: true, isPinned: true });
  } catch (error) {
    console.error('Error pinning message:', error);
    res.status(500).json({ error: 'Failed to pin message' });
  }
});

/**
 * POST /api/workspaces/:workspaceId/channels/:channelId/messages/:messageId/unpin
 * Unpin a message
 */
channelsRouter.post('/workspaces/:workspaceId/channels/:channelId/messages/:messageId/unpin', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { workspaceId, channelId, messageId } = req.params;

  try {
    const channel = await db.channels.findById(channelId);
    if (!channel || channel.workspaceId !== workspaceId) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    const message = await db.channelMessages.findById(messageId);
    if (!message || message.channelId !== channelId) {
      return res.status(404).json({ error: 'Message not found' });
    }

    // Only channel admins can unpin
    const isChAdmin = await isChannelAdmin(channelId, userId);
    const canManage = await canManageChannels(workspaceId, userId);
    if (!isChAdmin && !canManage) {
      return res.status(403).json({ error: 'Only admins can unpin messages' });
    }

    if (!message.isPinned) {
      return res.status(400).json({ error: 'Message is not pinned' });
    }

    await db.channelMessages.unpin(messageId);

    res.json({ success: true, isPinned: false });
  } catch (error) {
    console.error('Error unpinning message:', error);
    res.status(500).json({ error: 'Failed to unpin message' });
  }
});

/**
 * POST /api/workspaces/:workspaceId/channels/:channelId/read
 * Mark channel as read
 */
channelsRouter.post('/workspaces/:workspaceId/channels/:channelId/read', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { workspaceId, channelId } = req.params;
  const { lastMessageId } = req.body;

  try {
    const channel = await db.channels.findById(channelId);
    if (!channel || channel.workspaceId !== workspaceId) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Must be a member to mark as read
    const isMember = await db.channelMembers.isMember(channelId, userId, 'user');
    if (!isMember) {
      return res.status(403).json({ error: 'You must be a member to mark as read' });
    }

    let unreadCount = 0;

    if (lastMessageId) {
      // Mark read up to specific message and get remaining unread count
      unreadCount = await db.channelReadState.markReadUpTo(channelId, userId, lastMessageId);
    } else {
      // Mark all as read (backwards compatible)
      await db.channelReadState.markRead(channelId, userId);
    }

    res.json({ success: true, unreadCount });
  } catch (error) {
    console.error('Error marking channel as read:', error);
    res.status(500).json({ error: 'Failed to mark as read' });
  }
});

// ============================================================================
// Search Routes (Task 5: Full-Text Search)
// ============================================================================

/**
 * GET /api/workspaces/:workspaceId/search
 * Search messages across all accessible channels in a workspace
 */
channelsRouter.get('/workspaces/:workspaceId/search', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { workspaceId } = req.params;
  const { q, channelId, limit = '20', offset = '0' } = req.query;

  // Validate search query
  if (!q || typeof q !== 'string' || q.trim().length === 0) {
    return res.status(400).json({ error: 'Search query (q) is required' });
  }

  if (q.length > 500) {
    return res.status(400).json({ error: 'Search query too long (max 500 characters)' });
  }

  try {
    // Check user has access to workspace
    if (!(await canViewWorkspace(workspaceId, userId))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get all channels user can access
    const allChannels = await db.channels.findByWorkspaceId(workspaceId, { includeArchived: false });

    // Filter to channels user can access
    const accessibleChannelIds: string[] = [];
    for (const channel of allChannels) {
      if (!channel.isPrivate) {
        accessibleChannelIds.push(channel.id);
      } else {
        const isMember = await db.channelMembers.isMember(channel.id, userId, 'user');
        if (isMember) {
          accessibleChannelIds.push(channel.id);
        }
      }
    }

    if (accessibleChannelIds.length === 0) {
      return res.json({
        results: [],
        meta: {
          query: q,
          total: 0,
          limit: parseInt(limit as string),
          offset: parseInt(offset as string),
        },
      });
    }

    // Build search options
    const searchOptions = {
      channelIds: channelId ? undefined : accessibleChannelIds,
      channelId: channelId as string | undefined,
      limit: Math.min(parseInt(limit as string) || 20, 100),
      offset: parseInt(offset as string) || 0,
    };

    // If specific channel requested, verify access
    if (channelId) {
      if (!accessibleChannelIds.includes(channelId as string)) {
        return res.status(403).json({ error: 'Access denied to channel' });
      }
    }

    // Execute search
    const [results, total] = await Promise.all([
      db.channelMessages.search(q, searchOptions),
      db.channelMessages.searchCount(q, searchOptions),
    ]);

    // Build channel lookup for response
    const channelMap = new Map(allChannels.map(c => [c.id, c]));

    res.json({
      results: results.map(r => ({
        id: r.message.id,
        channelId: r.message.channelId,
        channelName: channelMap.get(r.message.channelId)?.name,
        from: r.message.senderName,
        fromId: r.message.senderId,
        fromEntityType: r.message.senderType,
        content: r.message.body,
        headline: r.headline,
        rank: r.rank,
        timestamp: r.message.createdAt.toISOString(),
        threadId: r.message.threadId,
        isPinned: r.message.isPinned,
      })),
      meta: {
        query: q,
        total,
        limit: searchOptions.limit,
        offset: searchOptions.offset,
        hasMore: searchOptions.offset + results.length < total,
      },
    });
  } catch (error) {
    console.error('Error searching messages:', error);
    res.status(500).json({ error: 'Failed to search messages' });
  }
});

/**
 * GET /api/workspaces/:workspaceId/channels/:channelId/search
 * Search messages within a specific channel
 */
channelsRouter.get('/workspaces/:workspaceId/channels/:channelId/search', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { workspaceId, channelId } = req.params;
  const { q, limit = '20', offset = '0' } = req.query;

  // Validate search query
  if (!q || typeof q !== 'string' || q.trim().length === 0) {
    return res.status(400).json({ error: 'Search query (q) is required' });
  }

  if (q.length > 500) {
    return res.status(400).json({ error: 'Search query too long (max 500 characters)' });
  }

  try {
    // Check user has access to workspace
    if (!(await canViewWorkspace(workspaceId, userId))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const channel = await db.channels.findById(channelId);
    if (!channel || channel.workspaceId !== workspaceId) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Check access for private channels
    if (channel.isPrivate) {
      const isMember = await db.channelMembers.isMember(channelId, userId, 'user');
      if (!isMember) {
        return res.status(403).json({ error: 'Access denied to private channel' });
      }
    }

    const searchOptions = {
      channelId,
      limit: Math.min(parseInt(limit as string) || 20, 100),
      offset: parseInt(offset as string) || 0,
    };

    // Execute search
    const [results, total] = await Promise.all([
      db.channelMessages.search(q, searchOptions),
      db.channelMessages.searchCount(q, searchOptions),
    ]);

    res.json({
      results: results.map(r => ({
        id: r.message.id,
        channelId: r.message.channelId,
        channelName: channel.name,
        from: r.message.senderName,
        fromId: r.message.senderId,
        fromEntityType: r.message.senderType,
        content: r.message.body,
        headline: r.headline,
        rank: r.rank,
        timestamp: r.message.createdAt.toISOString(),
        threadId: r.message.threadId,
        isPinned: r.message.isPinned,
      })),
      meta: {
        query: q,
        channelId,
        channelName: channel.name,
        total,
        limit: searchOptions.limit,
        offset: searchOptions.offset,
        hasMore: searchOptions.offset + results.length < total,
      },
    });
  } catch (error) {
    console.error('Error searching channel messages:', error);
    res.status(500).json({ error: 'Failed to search messages' });
  }
});
