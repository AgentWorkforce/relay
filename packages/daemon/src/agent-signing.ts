/**
 * Agent Authentication via Cryptographic Signing
 *
 * Provides agent identity verification through message signing.
 * Extends the existing UID/GID-based auth with cryptographic guarantees.
 *
 * Features:
 * - HMAC-SHA256 for shared-secret signing (simpler deployment)
 * - Ed25519 for asymmetric signing (zero-trust mode)
 * - Message signature verification
 * - Key rotation support
 * - Agent identity attestation
 */

import {
  createHmac,
  randomBytes,
  createHash,
  generateKeyPairSync,
  sign,
  verify,
  createPrivateKey,
  createPublicKey,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// =============================================================================
// Types
// =============================================================================

export interface AgentKeyPair {
  /** Agent identifier */
  agentName: string;
  /** Public key (hex) for asymmetric, or key ID for HMAC */
  publicKey: string;
  /** Private/secret key (hex) - never transmitted */
  privateKey: string;
  /** Key creation timestamp */
  createdAt: number;
  /** Optional expiry timestamp */
  expiresAt?: number;
  /** Signing algorithm */
  algorithm: 'hmac-sha256' | 'ed25519';
}

export interface SignedMessage {
  /** Original message content */
  content: string;
  /** Signature (hex) */
  signature: string;
  /** Signing agent */
  signer: string;
  /** Timestamp of signing */
  signedAt: number;
  /** Key ID used (for rotation support) */
  keyId: string;
  /** Algorithm used */
  algorithm: 'hmac-sha256' | 'ed25519';
}

export interface VerificationResult {
  valid: boolean;
  error?: string;
  signer?: string;
  signedAt?: number;
}

export interface AgentSigningConfig {
  /** Enable message signing (default: false) */
  enabled: boolean;
  /** Signing algorithm */
  algorithm: 'hmac-sha256' | 'ed25519';
  /** Require signatures on all messages */
  requireSignatures: boolean;
  /** Allow unsigned messages from specific agents */
  allowUnsignedFrom?: string[];
  /** Key directory path */
  keyDir?: string;
  /** Shared secret for HMAC mode (all agents share) */
  sharedSecret?: string;
  /** Key rotation interval in hours (0 = no rotation) */
  keyRotationHours?: number;
}

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: AgentSigningConfig = {
  enabled: false,
  algorithm: 'hmac-sha256',
  requireSignatures: false,
};

const DEFAULT_KEY_DIR = path.join(os.homedir(), '.agent-relay', 'keys');

// =============================================================================
// Key Management
// =============================================================================

/**
 * Generate a new agent key pair.
 */
export function generateAgentKey(
  agentName: string,
  algorithm: 'hmac-sha256' | 'ed25519' = 'hmac-sha256',
  expiresInHours?: number
): AgentKeyPair {
  const now = Date.now();

  if (algorithm === 'hmac-sha256') {
    // For HMAC, we generate a random secret
    const secret = randomBytes(32).toString('hex');
    const keyId = createHash('sha256')
      .update(`${agentName}:${secret}:${now}`)
      .digest('hex')
      .substring(0, 16);

    return {
      agentName,
      publicKey: keyId, // Key ID serves as public identifier
      privateKey: secret,
      createdAt: now,
      expiresAt: expiresInHours ? now + expiresInHours * 3600000 : undefined,
      algorithm,
    };
  }

  // Ed25519 asymmetric key generation
  const { publicKey: pubKeyObj, privateKey: privKeyObj } = generateKeyPairSync('ed25519');

  // Export keys in PEM format for storage
  const privateKeyPem = privKeyObj.export({ type: 'pkcs8', format: 'pem' }) as string;
  const publicKeyPem = pubKeyObj.export({ type: 'spki', format: 'pem' }) as string;

  // Create a key ID from the public key hash (for rotation tracking)
  const _keyId = createHash('sha256')
    .update(publicKeyPem)
    .digest('hex')
    .substring(0, 16);

  return {
    agentName,
    publicKey: publicKeyPem,
    privateKey: privateKeyPem,
    createdAt: now,
    expiresAt: expiresInHours ? now + expiresInHours * 3600000 : undefined,
    algorithm,
  };
}

/**
 * Save agent key to disk (private key file).
 */
export function saveAgentKey(key: AgentKeyPair, keyDir: string = DEFAULT_KEY_DIR): void {
  if (!fs.existsSync(keyDir)) {
    fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  }

  const keyPath = path.join(keyDir, `${key.agentName}.key.json`);
  fs.writeFileSync(keyPath, JSON.stringify(key, null, 2), {
    mode: 0o600, // Owner read/write only
  });
}

/**
 * Load agent key from disk.
 */
export function loadAgentKey(agentName: string, keyDir: string = DEFAULT_KEY_DIR): AgentKeyPair | null {
  const keyPath = path.join(keyDir, `${agentName}.key.json`);

  if (!fs.existsSync(keyPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(keyPath, 'utf-8');
    const key = JSON.parse(content) as AgentKeyPair;

    // Check expiry
    if (key.expiresAt && Date.now() > key.expiresAt) {
      console.warn(`[signing] Key for ${agentName} has expired`);
      return null;
    }

    return key;
  } catch (err) {
    console.error(`[signing] Failed to load key for ${agentName}:`, err);
    return null;
  }
}

/**
 * Load or generate agent key.
 */
export function getOrCreateAgentKey(
  agentName: string,
  config: AgentSigningConfig,
  keyDir: string = DEFAULT_KEY_DIR
): AgentKeyPair {
  let key = loadAgentKey(agentName, keyDir);

  if (!key) {
    key = generateAgentKey(agentName, config.algorithm, config.keyRotationHours);
    saveAgentKey(key, keyDir);
    console.log(`[signing] Generated new key for ${agentName}`);
  }

  return key;
}

// =============================================================================
// Message Signing
// =============================================================================

/**
 * Sign a message using the agent's private key.
 */
export function signMessage(
  content: string,
  key: AgentKeyPair
): SignedMessage {
  const signedAt = Date.now();
  const dataToSign = `${key.agentName}:${signedAt}:${content}`;

  let signature: string;
  let keyId: string;

  if (key.algorithm === 'hmac-sha256') {
    signature = createHmac('sha256', key.privateKey)
      .update(dataToSign)
      .digest('hex');
    keyId = key.publicKey; // For HMAC, publicKey is the key ID
  } else {
    // Ed25519 signing using Node.js native crypto
    const privateKeyObj = createPrivateKey(key.privateKey);
    const signatureBuffer = sign(null, Buffer.from(dataToSign), privateKeyObj);
    signature = signatureBuffer.toString('hex');
    // For Ed25519, derive key ID from public key hash
    keyId = createHash('sha256')
      .update(key.publicKey)
      .digest('hex')
      .substring(0, 16);
  }

  return {
    content,
    signature,
    signer: key.agentName,
    signedAt,
    keyId,
    algorithm: key.algorithm,
  };
}

/**
 * Sign with shared secret (HMAC mode where all agents share a secret).
 */
export function signWithSharedSecret(
  content: string,
  agentName: string,
  sharedSecret: string
): SignedMessage {
  const signedAt = Date.now();
  const dataToSign = `${agentName}:${signedAt}:${content}`;

  const signature = createHmac('sha256', sharedSecret)
    .update(dataToSign)
    .digest('hex');

  const keyId = createHash('sha256')
    .update(sharedSecret)
    .digest('hex')
    .substring(0, 16);

  return {
    content,
    signature,
    signer: agentName,
    signedAt,
    keyId,
    algorithm: 'hmac-sha256',
  };
}

// =============================================================================
// Message Verification
// =============================================================================

/**
 * Verify a signed message using the agent's public key.
 */
export function verifyMessage(
  signed: SignedMessage,
  key: AgentKeyPair
): VerificationResult {
  // Check signer matches key
  if (signed.signer !== key.agentName) {
    return {
      valid: false,
      error: `Signer mismatch: expected ${key.agentName}, got ${signed.signer}`,
    };
  }

  // Check key ID for HMAC, or derive it for Ed25519
  const expectedKeyId = key.algorithm === 'hmac-sha256'
    ? key.publicKey
    : createHash('sha256').update(key.publicKey).digest('hex').substring(0, 16);

  if (signed.keyId !== expectedKeyId) {
    return {
      valid: false,
      error: `Key ID mismatch: expected ${expectedKeyId}, got ${signed.keyId}`,
    };
  }

  // Check expiry
  if (key.expiresAt && Date.now() > key.expiresAt) {
    return {
      valid: false,
      error: 'Signing key has expired',
    };
  }

  // Verify signature
  const dataToVerify = `${signed.signer}:${signed.signedAt}:${signed.content}`;

  if (key.algorithm === 'hmac-sha256') {
    // HMAC verification: recompute and compare
    const expectedSignature = createHmac('sha256', key.privateKey)
      .update(dataToVerify)
      .digest('hex');

    if (signed.signature !== expectedSignature) {
      return {
        valid: false,
        error: 'Invalid signature',
      };
    }
  } else {
    // Ed25519 verification using public key only (true asymmetric verification)
    try {
      const publicKeyObj = createPublicKey(key.publicKey);
      const signatureBuffer = Buffer.from(signed.signature, 'hex');
      const isValid = verify(null, Buffer.from(dataToVerify), publicKeyObj, signatureBuffer);

      if (!isValid) {
        return {
          valid: false,
          error: 'Invalid signature',
        };
      }
    } catch (err) {
      return {
        valid: false,
        error: `Signature verification failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      };
    }
  }

  return {
    valid: true,
    signer: signed.signer,
    signedAt: signed.signedAt,
  };
}

/**
 * Verify an Ed25519 signed message using only the public key.
 * This is the key advantage of asymmetric signing - verifiers don't need the private key.
 */
export function verifyEd25519WithPublicKey(
  signed: SignedMessage,
  publicKeyPem: string,
  expectedSigner: string
): VerificationResult {
  if (signed.algorithm !== 'ed25519') {
    return {
      valid: false,
      error: `Algorithm mismatch: expected ed25519, got ${signed.algorithm}`,
    };
  }

  if (signed.signer !== expectedSigner) {
    return {
      valid: false,
      error: `Signer mismatch: expected ${expectedSigner}, got ${signed.signer}`,
    };
  }

  const expectedKeyId = createHash('sha256')
    .update(publicKeyPem)
    .digest('hex')
    .substring(0, 16);

  if (signed.keyId !== expectedKeyId) {
    return {
      valid: false,
      error: `Key ID mismatch: expected ${expectedKeyId}, got ${signed.keyId}`,
    };
  }

  const dataToVerify = `${signed.signer}:${signed.signedAt}:${signed.content}`;

  try {
    const publicKeyObj = createPublicKey(publicKeyPem);
    const signatureBuffer = Buffer.from(signed.signature, 'hex');
    const isValid = verify(null, Buffer.from(dataToVerify), publicKeyObj, signatureBuffer);

    if (!isValid) {
      return {
        valid: false,
        error: 'Invalid signature',
      };
    }
  } catch (err) {
    return {
      valid: false,
      error: `Signature verification failed: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }

  return {
    valid: true,
    signer: signed.signer,
    signedAt: signed.signedAt,
  };
}

/**
 * Verify with shared secret.
 */
export function verifyWithSharedSecret(
  signed: SignedMessage,
  sharedSecret: string
): VerificationResult {
  const dataToSign = `${signed.signer}:${signed.signedAt}:${signed.content}`;

  const expectedSignature = createHmac('sha256', sharedSecret)
    .update(dataToSign)
    .digest('hex');

  if (signed.signature !== expectedSignature) {
    return {
      valid: false,
      error: 'Invalid signature',
    };
  }

  return {
    valid: true,
    signer: signed.signer,
    signedAt: signed.signedAt,
  };
}

// =============================================================================
// Agent Signing Manager
// =============================================================================

/**
 * Manages agent signing keys and verification.
 */
export class AgentSigningManager {
  private config: AgentSigningConfig;
  private keyDir: string;
  private keys: Map<string, AgentKeyPair> = new Map();

  constructor(config: Partial<AgentSigningConfig> = {}, keyDir?: string) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.keyDir = keyDir ?? DEFAULT_KEY_DIR;
  }

  /**
   * Check if signing is enabled.
   */
  get enabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Get or load key for an agent.
   */
  getKey(agentName: string): AgentKeyPair | null {
    // Check cache
    const cached = this.keys.get(agentName);
    if (cached) {
      // Check expiry
      if (cached.expiresAt && Date.now() > cached.expiresAt) {
        this.keys.delete(agentName);
      } else {
        return cached;
      }
    }

    // Load from disk
    const key = loadAgentKey(agentName, this.keyDir);
    if (key) {
      this.keys.set(agentName, key);
    }

    return key;
  }

  /**
   * Register a new agent (generate and save key).
   */
  registerAgent(agentName: string): AgentKeyPair {
    const key = getOrCreateAgentKey(agentName, this.config, this.keyDir);
    this.keys.set(agentName, key);
    return key;
  }

  /**
   * Sign a message for an agent.
   */
  sign(agentName: string, content: string): SignedMessage | null {
    if (!this.config.enabled) {
      return null;
    }

    // Shared secret mode
    if (this.config.sharedSecret) {
      return signWithSharedSecret(content, agentName, this.config.sharedSecret);
    }

    // Per-agent key mode
    const key = this.getKey(agentName);
    if (!key) {
      console.warn(`[signing] No key found for ${agentName}, cannot sign`);
      return null;
    }

    return signMessage(content, key);
  }

  /**
   * Verify a signed message.
   */
  verify(signed: SignedMessage): VerificationResult {
    if (!this.config.enabled) {
      return { valid: true }; // Signing disabled, accept all
    }

    // Check if unsigned messages are allowed from this agent
    if (this.config.allowUnsignedFrom?.includes(signed.signer)) {
      return { valid: true, signer: signed.signer };
    }

    // Shared secret mode
    if (this.config.sharedSecret) {
      return verifyWithSharedSecret(signed, this.config.sharedSecret);
    }

    // Per-agent key mode
    const key = this.getKey(signed.signer);
    if (!key) {
      if (this.config.requireSignatures) {
        return {
          valid: false,
          error: `No key found for signer ${signed.signer}`,
        };
      }
      // Key not found but signatures not required
      return { valid: true, signer: signed.signer };
    }

    return verifyMessage(signed, key);
  }

  /**
   * Check if a message requires verification.
   */
  requiresVerification(agentName: string): boolean {
    if (!this.config.enabled) return false;
    if (!this.config.requireSignatures) return false;
    if (this.config.allowUnsignedFrom?.includes(agentName)) return false;
    return true;
  }

  /**
   * Rotate key for an agent.
   */
  rotateKey(agentName: string): AgentKeyPair {
    // Generate new key
    const newKey = generateAgentKey(
      agentName,
      this.config.algorithm,
      this.config.keyRotationHours
    );

    // Save and cache
    saveAgentKey(newKey, this.keyDir);
    this.keys.set(agentName, newKey);

    console.log(`[signing] Rotated key for ${agentName}`);
    return newKey;
  }

  /**
   * Export public key for an agent (for sharing with other systems).
   */
  exportPublicKey(agentName: string): { agentName: string; publicKey: string; algorithm: string } | null {
    const key = this.getKey(agentName);
    if (!key) return null;

    return {
      agentName: key.agentName,
      publicKey: key.publicKey,
      algorithm: key.algorithm,
    };
  }
}

// =============================================================================
// Integration Helpers
// =============================================================================

/**
 * Attach signature to protocol envelope.
 */
export function attachSignature(
  envelope: Record<string, unknown>,
  signed: SignedMessage
): Record<string, unknown> {
  return {
    ...envelope,
    _sig: {
      s: signed.signature,
      k: signed.keyId,
      t: signed.signedAt,
      a: signed.algorithm,
    },
  };
}

/**
 * Extract signature from protocol envelope.
 */
export function extractSignature(
  envelope: Record<string, unknown>
): SignedMessage | null {
  const sig = envelope._sig as {
    s?: string;
    k?: string;
    t?: number;
    a?: string;
  } | undefined;

  if (!sig || !sig.s || !sig.k || !sig.t) {
    return null;
  }

  // Reconstruct the signed content (envelope without _sig)
  const { _sig, ...rest } = envelope;
  const content = JSON.stringify(rest);

  // Safely extract signer from envelope
  const signer = typeof envelope.from === 'string' ? envelope.from : 'unknown';

  // Validate algorithm value
  const algorithm: 'hmac-sha256' | 'ed25519' =
    sig.a === 'ed25519' ? 'ed25519' : 'hmac-sha256';

  return {
    content,
    signature: sig.s,
    signer,
    signedAt: sig.t,
    keyId: sig.k,
    algorithm,
  };
}

// =============================================================================
// Configuration Loading
// =============================================================================

const SIGNING_CONFIG_PATHS = [
  path.join(os.homedir(), '.agent-relay', 'signing.json'),
  path.join(os.homedir(), '.config', 'agent-relay', 'signing.json'),
  '/etc/agent-relay/signing.json',
];

/**
 * Load signing configuration from file.
 */
export function loadSigningConfig(configPath?: string): AgentSigningConfig {
  const paths = configPath ? [configPath] : SIGNING_CONFIG_PATHS;

  for (const p of paths) {
    if (fs.existsSync(p)) {
      try {
        const content = fs.readFileSync(p, 'utf-8');
        const config = JSON.parse(content) as Partial<AgentSigningConfig>;
        console.log(`[signing] Loaded config from ${p}`);
        return { ...DEFAULT_CONFIG, ...config };
      } catch (err) {
        console.error(`[signing] Failed to parse ${p}:`, err);
      }
    }
  }

  return DEFAULT_CONFIG;
}
