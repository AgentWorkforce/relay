/**
 * Email Auth API Routes
 *
 * Handles email/password authentication:
 * - Signup with email/password
 * - Login with email/password
 * - Email verification
 * - Password reset (future)
 */

import { Router, Request, Response } from 'express';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { db } from '../db/index.js';
import { requireAuth } from './auth.js';

const scryptAsync = promisify(scrypt);

export const emailAuthRouter = Router();

// Password hashing configuration
const SALT_LENGTH = 32;
const KEY_LENGTH = 64;

/**
 * Hash a password using scrypt
 */
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derivedKey = await scryptAsync(password, salt, KEY_LENGTH) as Buffer;
  return `${salt.toString('hex')}:${derivedKey.toString('hex')}`;
}

/**
 * Verify a password against a hash
 */
async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  try {
    const [saltHex, keyHex] = storedHash.split(':');
    if (!saltHex || !keyHex) return false;

    const salt = Buffer.from(saltHex, 'hex');
    const storedKey = Buffer.from(keyHex, 'hex');
    const derivedKey = await scryptAsync(password, salt, KEY_LENGTH) as Buffer;

    return timingSafeEqual(storedKey, derivedKey);
  } catch {
    return false;
  }
}

/**
 * Generate a random verification token
 */
function generateVerificationToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Validate email format
 */
function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Validate password strength
 */
function isValidPassword(password: string): { valid: boolean; message?: string } {
  if (password.length < 8) {
    return { valid: false, message: 'Password must be at least 8 characters long' };
  }
  if (password.length > 128) {
    return { valid: false, message: 'Password must be less than 128 characters' };
  }
  return { valid: true };
}

/**
 * POST /api/auth/email/signup
 * Create a new account with email/password
 */
emailAuthRouter.post('/signup', async (req: Request, res: Response) => {
  try {
    const { email, password, displayName } = req.body;

    // Validate input
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email is required' });
    }

    if (!password || typeof password !== 'string') {
      return res.status(400).json({ error: 'Password is required' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const passwordValidation = isValidPassword(password);
    if (!passwordValidation.valid) {
      return res.status(400).json({ error: passwordValidation.message });
    }

    // Check if email already exists (in users.email or user_emails table)
    // This enables account reconciliation - if someone signed up via GitHub,
    // their linked emails will be found and they should log in instead
    const existingUser = await db.userEmails.findUserByEmail(normalizedEmail);
    if (existingUser) {
      // If the existing user signed up via GitHub, offer to use that account
      if (existingUser.githubId && !existingUser.passwordHash) {
        return res.status(409).json({
          error: 'This email is associated with a GitHub account. Please log in with GitHub, or set a password on that account.',
          code: 'GITHUB_ACCOUNT_EXISTS',
        });
      }
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    // Hash password and create user
    const passwordHash = await hashPassword(password);
    const user = await db.users.createEmailUser({
      email: normalizedEmail,
      passwordHash,
      displayName: displayName?.trim() || undefined,
    });

    // Generate verification token
    const verificationToken = generateVerificationToken();
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
    await db.users.setEmailVerificationToken(user.id, verificationToken, verificationExpires);

    // TODO: Send verification email
    // For now, we'll auto-verify in development or skip email verification
    // In production, you would send an email with a link containing the token

    // Set session
    req.session.userId = user.id;

    res.status(201).json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        emailVerified: user.emailVerified,
      },
      // Include verification token in development for testing
      ...(process.env.NODE_ENV !== 'production' && { verificationToken }),
    });
  } catch (error) {
    console.error('Email signup error:', error);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

/**
 * POST /api/auth/email/login
 * Login with email/password
 *
 * Supports account reconciliation: users can log in with any email address
 * linked to their account via GitHub, not just their primary email.
 */
emailAuthRouter.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    // Validate input
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email is required' });
    }

    if (!password || typeof password !== 'string') {
      return res.status(400).json({ error: 'Password is required' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Find user by email - checks both user_emails table (GitHub-linked emails)
    // and users.email (primary email), enabling account reconciliation
    const user = await db.userEmails.findUserByEmail(normalizedEmail);
    if (!user) {
      // Use same message for security (don't reveal if email exists)
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Check if user has a password (might be GitHub-only user)
    if (!user.passwordHash) {
      return res.status(401).json({
        error: 'This account uses GitHub login. Please sign in with GitHub, or set a password to enable email login.',
        code: 'GITHUB_ACCOUNT',
      });
    }

    // Verify password
    const isValid = await verifyPassword(password, user.passwordHash);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Set session
    req.session.userId = user.id;

    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        githubUsername: user.githubUsername,
        avatarUrl: user.avatarUrl,
        emailVerified: user.emailVerified,
      },
    });
  } catch (error) {
    console.error('Email login error:', error);
    res.status(500).json({ error: 'Failed to login' });
  }
});

/**
 * POST /api/auth/email/verify
 * Verify email with token
 */
emailAuthRouter.post('/verify', async (req: Request, res: Response) => {
  try {
    const { token } = req.body;

    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'Verification token is required' });
    }

    // Find user by token
    const user = await db.users.findByEmailVerificationToken(token);
    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired verification token' });
    }

    // Check if token expired
    if (user.emailVerificationExpires && user.emailVerificationExpires < new Date()) {
      return res.status(400).json({ error: 'Verification token has expired' });
    }

    // Verify email
    await db.users.verifyEmail(user.id);

    res.json({
      success: true,
      message: 'Email verified successfully',
    });
  } catch (error) {
    console.error('Email verification error:', error);
    res.status(500).json({ error: 'Failed to verify email' });
  }
});

/**
 * POST /api/auth/email/resend-verification
 * Resend verification email (requires auth)
 */
emailAuthRouter.post('/resend-verification', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const user = await db.users.findById(userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.emailVerified) {
      return res.status(400).json({ error: 'Email is already verified' });
    }

    if (!user.email) {
      return res.status(400).json({ error: 'No email address on this account' });
    }

    // Generate new verification token
    const verificationToken = generateVerificationToken();
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
    await db.users.setEmailVerificationToken(user.id, verificationToken, verificationExpires);

    // TODO: Send verification email
    // For now, return success and include token in development

    res.json({
      success: true,
      message: 'Verification email sent',
      ...(process.env.NODE_ENV !== 'production' && { verificationToken }),
    });
  } catch (error) {
    console.error('Resend verification error:', error);
    res.status(500).json({ error: 'Failed to resend verification email' });
  }
});

/**
 * POST /api/auth/set-email
 * Set email for GitHub users who don't have one (requires auth)
 */
emailAuthRouter.post('/set-email', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const { email } = req.body;

    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email is required' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const user = await db.users.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check if user already has an email
    if (user.email) {
      return res.status(400).json({ error: 'Email is already set for this account' });
    }

    // Check if email is already used by another user (including in user_emails table)
    const isLinkedToOther = await db.userEmails.isEmailLinkedToOtherUser(normalizedEmail, userId);
    if (isLinkedToOther) {
      return res.status(409).json({ error: 'This email is already associated with another account' });
    }

    // Also check users.email directly
    const existingUser = await db.users.findByEmail(normalizedEmail);
    if (existingUser && existingUser.id !== userId) {
      return res.status(409).json({ error: 'This email is already associated with another account' });
    }

    // Update user with email
    await db.users.update(userId, { email: normalizedEmail });

    // Generate verification token
    const verificationToken = generateVerificationToken();
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
    await db.users.setEmailVerificationToken(userId, verificationToken, verificationExpires);

    // TODO: Send verification email

    res.json({
      success: true,
      message: 'Email set successfully',
      email: normalizedEmail,
      ...(process.env.NODE_ENV !== 'production' && { verificationToken }),
    });
  } catch (error) {
    console.error('Set email error:', error);
    res.status(500).json({ error: 'Failed to set email' });
  }
});

/**
 * POST /api/auth/email/set-password
 * Set password for GitHub users who want to add email login (requires auth)
 */
emailAuthRouter.post('/set-password', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const { password } = req.body;

    if (!password || typeof password !== 'string') {
      return res.status(400).json({ error: 'Password is required' });
    }

    const passwordValidation = isValidPassword(password);
    if (!passwordValidation.valid) {
      return res.status(400).json({ error: passwordValidation.message });
    }

    const user = await db.users.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!user.email) {
      return res.status(400).json({ error: 'Please set an email address first' });
    }

    // Hash password and update user
    const passwordHash = await hashPassword(password);
    await db.users.updatePassword(userId, passwordHash);

    res.json({
      success: true,
      message: 'Password set successfully',
    });
  } catch (error) {
    console.error('Set password error:', error);
    res.status(500).json({ error: 'Failed to set password' });
  }
});
