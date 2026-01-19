/**
 * Teams API Routes
 *
 * Manage workspace members, invitations, and roles.
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from './auth.js';
import { db, WorkspaceMemberRole } from '../db/index.js';

export const teamsRouter = Router();

// All routes require authentication
teamsRouter.use(requireAuth);

/**
 * GET /api/workspaces/:workspaceId/members
 * List workspace members
 */
teamsRouter.get('/workspaces/:workspaceId/members', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const workspaceId = req.params.workspaceId as string;

  try {
    // Check user has access to workspace
    const canView = await db.workspaceMembers.canView(workspaceId, userId);
    if (!canView) {
      // Also check if user is the workspace owner (legacy single-user workspaces)
      const workspace = await db.workspaces.findById(workspaceId);
      if (!workspace || workspace.userId !== userId) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    const members = await db.workspaceMembers.findByWorkspaceId(workspaceId);

    // Fetch user info for each member
    const membersWithUsers = await Promise.all(
      members.map(async (m) => {
        const user = await db.users.findById(m.userId);
        return {
          id: m.id,
          userId: m.userId,
          role: m.role,
          invitedAt: m.invitedAt,
          acceptedAt: m.acceptedAt,
          isPending: !m.acceptedAt,
          user: user
            ? {
                githubUsername: user.githubUsername,
                email: user.email ?? undefined,
                avatarUrl: user.avatarUrl ?? undefined,
              }
            : undefined,
        };
      })
    );

    res.json({ members: membersWithUsers });
  } catch (error) {
    console.error('Error listing members:', error);
    res.status(500).json({ error: 'Failed to list members' });
  }
});

/**
 * POST /api/workspaces/:workspaceId/members
 * Invite a user to workspace
 */
teamsRouter.post('/workspaces/:workspaceId/members', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const workspaceId = req.params.workspaceId as string;
  const { githubUsername, role = 'member' } = req.body;

  if (!githubUsername) {
    return res.status(400).json({ error: 'GitHub username is required' });
  }

  const validRoles: WorkspaceMemberRole[] = ['admin', 'member', 'viewer'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: 'Invalid role. Must be admin, member, or viewer' });
  }

  try {
    // Check user is owner or admin
    const isOwner = await db.workspaceMembers.isOwner(workspaceId, userId);
    const workspace = await db.workspaces.findById(workspaceId);

    if (!isOwner && workspace?.userId !== userId) {
      const membership = await db.workspaceMembers.findMembership(workspaceId, userId);
      if (!membership || membership.role !== 'admin') {
        return res.status(403).json({ error: 'Only owners and admins can invite members' });
      }
    }

    // Check plan allows team members
    const owner = await db.users.findById(workspace!.userId);
    if (owner?.plan !== 'team' && owner?.plan !== 'enterprise') {
      return res.status(402).json({
        error: 'Team members require Team or Enterprise plan',
        upgrade: '/settings/billing',
      });
    }

    // Find user by GitHub username
    const invitee = await db.users.findByGithubUsername(githubUsername);
    if (!invitee) {
      return res.status(404).json({
        error: 'User not found. They must sign up first.',
        inviteLink: `https://agent-relay.com/invite?workspace=${workspaceId}`,
      });
    }

    // Check if already a member
    const existing = await db.workspaceMembers.findMembership(workspaceId, invitee.id);
    if (existing) {
      return res.status(409).json({ error: 'User is already a member' });
    }

    // Add member (pending acceptance)
    const member = await db.workspaceMembers.addMember({
      workspaceId,
      userId: invitee.id,
      role,
      invitedBy: userId,
    });

    // TODO: Send email notification to invitee

    res.status(201).json({
      success: true,
      member: {
        id: member.id,
        userId: member.userId,
        role: member.role,
        isPending: true,
        user: {
          githubUsername: invitee.githubUsername,
          email: invitee.email,
          avatarUrl: invitee.avatarUrl,
        },
      },
    });
  } catch (error) {
    console.error('Error inviting member:', error);
    res.status(500).json({ error: 'Failed to invite member' });
  }
});

/**
 * PATCH /api/workspaces/:workspaceId/members/:memberId
 * Update member role
 */
teamsRouter.patch('/workspaces/:workspaceId/members/:memberId', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const workspaceId = req.params.workspaceId as string;
  const memberId = req.params.memberId as string;
  const { role } = req.body;

  const validRoles: WorkspaceMemberRole[] = ['admin', 'member', 'viewer'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  try {
    // Check user is owner or admin
    const isOwner = await db.workspaceMembers.isOwner(workspaceId, userId);
    const workspace = await db.workspaces.findById(workspaceId);

    if (!isOwner && workspace?.userId !== userId) {
      return res.status(403).json({ error: 'Only owners can change roles' });
    }

    // Get the member to update
    const members = await db.workspaceMembers.findByWorkspaceId(workspaceId);
    const member = members.find((m) => m.id === memberId);

    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    // Can't change owner role
    if (member.role === 'owner') {
      return res.status(400).json({ error: 'Cannot change owner role' });
    }

    await db.workspaceMembers.updateRole(workspaceId, member.userId, role);

    res.json({ success: true, role });
  } catch (error) {
    console.error('Error updating role:', error);
    res.status(500).json({ error: 'Failed to update role' });
  }
});

/**
 * DELETE /api/workspaces/:workspaceId/members/:memberId
 * Remove member from workspace
 */
teamsRouter.delete('/workspaces/:workspaceId/members/:memberId', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const workspaceId = req.params.workspaceId as string;
  const memberId = req.params.memberId as string;

  try {
    const members = await db.workspaceMembers.findByWorkspaceId(workspaceId);
    const member = members.find((m) => m.id === memberId);

    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    // Users can remove themselves
    if (member.userId === userId) {
      if (member.role === 'owner') {
        return res.status(400).json({ error: 'Owner cannot leave. Transfer ownership first.' });
      }
      await db.workspaceMembers.removeMember(workspaceId, userId);
      return res.json({ success: true });
    }

    // Otherwise, must be owner or admin
    const isOwner = await db.workspaceMembers.isOwner(workspaceId, userId);
    const workspace = await db.workspaces.findById(workspaceId);

    if (!isOwner && workspace?.userId !== userId) {
      const myMembership = await db.workspaceMembers.findMembership(workspaceId, userId);
      if (!myMembership || myMembership.role !== 'admin') {
        return res.status(403).json({ error: 'Permission denied' });
      }
    }

    // Can't remove owner
    if (member.role === 'owner') {
      return res.status(400).json({ error: 'Cannot remove owner' });
    }

    await db.workspaceMembers.removeMember(workspaceId, member.userId);

    res.json({ success: true });
  } catch (error) {
    console.error('Error removing member:', error);
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

/**
 * GET /api/invites
 * Get pending invites for current user
 */
teamsRouter.get('/invites', async (req: Request, res: Response) => {
  const userId = req.session.userId!;

  try {
    const invites = await db.workspaceMembers.getPendingInvites(userId);

    res.json({
      invites: invites.map((inv: any) => ({
        id: inv.id,
        workspaceId: inv.workspaceId,
        workspaceName: inv.workspace_name,
        role: inv.role,
        invitedAt: inv.invitedAt,
        invitedBy: inv.inviter_username,
      })),
    });
  } catch (error) {
    console.error('Error getting invites:', error);
    res.status(500).json({ error: 'Failed to get invites' });
  }
});

/**
 * POST /api/invites/:inviteId/accept
 * Accept workspace invitation
 */
teamsRouter.post('/invites/:inviteId/accept', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const inviteId = req.params.inviteId as string;

  try {
    const invites = await db.workspaceMembers.getPendingInvites(userId);
    const invite = invites.find((i) => i.id === inviteId);

    if (!invite) {
      return res.status(404).json({ error: 'Invite not found' });
    }

    await db.workspaceMembers.acceptInvite(invite.workspaceId, userId);

    res.json({
      success: true,
      workspaceId: invite.workspaceId,
      message: 'Invitation accepted',
    });
  } catch (error) {
    console.error('Error accepting invite:', error);
    res.status(500).json({ error: 'Failed to accept invite' });
  }
});

/**
 * POST /api/invites/:inviteId/decline
 * Decline workspace invitation
 */
teamsRouter.post('/invites/:inviteId/decline', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const inviteId = req.params.inviteId as string;

  try {
    const invites = await db.workspaceMembers.getPendingInvites(userId);
    const invite = invites.find((i) => i.id === inviteId);

    if (!invite) {
      return res.status(404).json({ error: 'Invite not found' });
    }

    await db.workspaceMembers.removeMember(invite.workspaceId, userId);

    res.json({ success: true, message: 'Invitation declined' });
  } catch (error) {
    console.error('Error declining invite:', error);
    res.status(500).json({ error: 'Failed to decline invite' });
  }
});
