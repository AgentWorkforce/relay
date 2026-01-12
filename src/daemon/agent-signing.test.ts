/**
 * Tests for Agent Authentication with Signing
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  generateAgentKey,
  saveAgentKey,
  loadAgentKey,
  getOrCreateAgentKey,
  signMessage,
  signWithSharedSecret,
  verifyMessage,
  verifyWithSharedSecret,
  verifyEd25519WithPublicKey,
  AgentSigningManager,
  attachSignature,
  extractSignature,
  loadSigningConfig,
  type SignedMessage,
  type AgentSigningConfig,
} from './agent-signing.js';

// =============================================================================
// Test Setup
// =============================================================================

describe('Agent Signing', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-signing-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // ===========================================================================
  // Key Generation Tests
  // ===========================================================================

  describe('generateAgentKey', () => {
    it('generates HMAC-SHA256 key', () => {
      const key = generateAgentKey('TestAgent', 'hmac-sha256');

      expect(key.agentName).toBe('TestAgent');
      expect(key.algorithm).toBe('hmac-sha256');
      expect(key.publicKey).toHaveLength(16); // Key ID
      expect(key.privateKey).toHaveLength(64); // 32 bytes hex
      expect(key.createdAt).toBeLessThanOrEqual(Date.now());
      expect(key.expiresAt).toBeUndefined();
    });

    it('generates Ed25519 key with PEM format', () => {
      const key = generateAgentKey('TestAgent', 'ed25519');

      expect(key.agentName).toBe('TestAgent');
      expect(key.algorithm).toBe('ed25519');
      // Keys are in PEM format
      expect(key.publicKey).toContain('-----BEGIN PUBLIC KEY-----');
      expect(key.publicKey).toContain('-----END PUBLIC KEY-----');
      expect(key.privateKey).toContain('-----BEGIN PRIVATE KEY-----');
      expect(key.privateKey).toContain('-----END PRIVATE KEY-----');
    });

    it('generates unique Ed25519 keys', () => {
      const key1 = generateAgentKey('Agent1', 'ed25519');
      const key2 = generateAgentKey('Agent2', 'ed25519');

      expect(key1.publicKey).not.toBe(key2.publicKey);
      expect(key1.privateKey).not.toBe(key2.privateKey);
    });

    it('sets expiry when specified', () => {
      const key = generateAgentKey('TestAgent', 'hmac-sha256', 24);

      expect(key.expiresAt).toBeDefined();
      const expectedExpiry = key.createdAt + 24 * 3600 * 1000;
      expect(key.expiresAt).toBe(expectedExpiry);
    });

    it('generates unique keys', () => {
      const key1 = generateAgentKey('Agent1');
      const key2 = generateAgentKey('Agent2');
      const key3 = generateAgentKey('Agent1'); // Same name, different key

      expect(key1.privateKey).not.toBe(key2.privateKey);
      expect(key1.privateKey).not.toBe(key3.privateKey);
      expect(key1.publicKey).not.toBe(key3.publicKey);
    });
  });

  // ===========================================================================
  // Key Storage Tests
  // ===========================================================================

  describe('saveAgentKey', () => {
    it('saves key to disk', () => {
      const key = generateAgentKey('TestAgent');
      saveAgentKey(key, tempDir);

      const keyPath = path.join(tempDir, 'TestAgent.key.json');
      expect(fs.existsSync(keyPath)).toBe(true);
    });

    it('creates directory if needed', () => {
      const key = generateAgentKey('TestAgent');
      const nestedDir = path.join(tempDir, 'nested', 'keys');
      saveAgentKey(key, nestedDir);

      const keyPath = path.join(nestedDir, 'TestAgent.key.json');
      expect(fs.existsSync(keyPath)).toBe(true);
    });

    it('saves valid JSON', () => {
      const key = generateAgentKey('TestAgent');
      saveAgentKey(key, tempDir);

      const keyPath = path.join(tempDir, 'TestAgent.key.json');
      const content = fs.readFileSync(keyPath, 'utf-8');
      const parsed = JSON.parse(content);

      expect(parsed.agentName).toBe('TestAgent');
      expect(parsed.privateKey).toBe(key.privateKey);
    });
  });

  describe('loadAgentKey', () => {
    it('loads key from disk', () => {
      const original = generateAgentKey('TestAgent');
      saveAgentKey(original, tempDir);

      const loaded = loadAgentKey('TestAgent', tempDir);

      expect(loaded).not.toBeNull();
      expect(loaded!.agentName).toBe(original.agentName);
      expect(loaded!.privateKey).toBe(original.privateKey);
      expect(loaded!.publicKey).toBe(original.publicKey);
    });

    it('returns null for missing key', () => {
      const loaded = loadAgentKey('NonExistent', tempDir);
      expect(loaded).toBeNull();
    });

    it('returns null for expired key', () => {
      const key = generateAgentKey('TestAgent', 'hmac-sha256', -1); // Already expired
      saveAgentKey(key, tempDir);

      const loaded = loadAgentKey('TestAgent', tempDir);
      expect(loaded).toBeNull();
    });
  });

  describe('getOrCreateAgentKey', () => {
    it('creates new key if none exists', () => {
      const config: AgentSigningConfig = {
        enabled: true,
        algorithm: 'hmac-sha256',
        requireSignatures: false,
      };

      const key = getOrCreateAgentKey('NewAgent', config, tempDir);

      expect(key.agentName).toBe('NewAgent');
      expect(fs.existsSync(path.join(tempDir, 'NewAgent.key.json'))).toBe(true);
    });

    it('loads existing key if available', () => {
      const original = generateAgentKey('ExistingAgent');
      saveAgentKey(original, tempDir);

      const config: AgentSigningConfig = {
        enabled: true,
        algorithm: 'hmac-sha256',
        requireSignatures: false,
      };

      const key = getOrCreateAgentKey('ExistingAgent', config, tempDir);

      expect(key.privateKey).toBe(original.privateKey);
    });
  });

  // ===========================================================================
  // Message Signing Tests
  // ===========================================================================

  describe('signMessage', () => {
    it('signs message with agent key', () => {
      const key = generateAgentKey('TestAgent');
      const signed = signMessage('Hello world', key);

      expect(signed.content).toBe('Hello world');
      expect(signed.signer).toBe('TestAgent');
      expect(signed.signature).toHaveLength(64); // SHA256 hex
      expect(signed.keyId).toBe(key.publicKey);
      expect(signed.algorithm).toBe('hmac-sha256');
      expect(signed.signedAt).toBeLessThanOrEqual(Date.now());
    });

    it('produces different signatures for different content', () => {
      const key = generateAgentKey('TestAgent');
      const signed1 = signMessage('Hello', key);
      const signed2 = signMessage('World', key);

      expect(signed1.signature).not.toBe(signed2.signature);
    });

    it('produces different signatures for same content at different times', async () => {
      const key = generateAgentKey('TestAgent');
      const signed1 = signMessage('Hello', key);
      await new Promise(r => setTimeout(r, 10));
      const signed2 = signMessage('Hello', key);

      // Different timestamps should produce different signatures
      expect(signed1.signature).not.toBe(signed2.signature);
    });
  });

  describe('signWithSharedSecret', () => {
    it('signs message with shared secret', () => {
      const signed = signWithSharedSecret('Hello world', 'TestAgent', 'my-secret');

      expect(signed.content).toBe('Hello world');
      expect(signed.signer).toBe('TestAgent');
      expect(signed.signature).toHaveLength(64);
      expect(signed.algorithm).toBe('hmac-sha256');
    });

    it('different agents with same secret produce different signatures', () => {
      const signed1 = signWithSharedSecret('Hello', 'Agent1', 'secret');
      const signed2 = signWithSharedSecret('Hello', 'Agent2', 'secret');

      expect(signed1.signature).not.toBe(signed2.signature);
    });
  });

  // ===========================================================================
  // Message Verification Tests
  // ===========================================================================

  describe('verifyMessage', () => {
    it('verifies valid signature', () => {
      const key = generateAgentKey('TestAgent');
      const signed = signMessage('Hello world', key);
      const result = verifyMessage(signed, key);

      expect(result.valid).toBe(true);
      expect(result.signer).toBe('TestAgent');
      expect(result.signedAt).toBe(signed.signedAt);
    });

    it('rejects tampered content', () => {
      const key = generateAgentKey('TestAgent');
      const signed = signMessage('Hello world', key);
      signed.content = 'Tampered content';

      const result = verifyMessage(signed, key);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid signature');
    });

    it('rejects tampered signature', () => {
      const key = generateAgentKey('TestAgent');
      const signed = signMessage('Hello world', key);
      signed.signature = 'a'.repeat(64);

      const result = verifyMessage(signed, key);
      expect(result.valid).toBe(false);
    });

    it('rejects wrong signer', () => {
      const key = generateAgentKey('TestAgent');
      const signed = signMessage('Hello world', key);
      signed.signer = 'WrongAgent';

      const result = verifyMessage(signed, key);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Signer mismatch');
    });

    it('rejects wrong key ID', () => {
      const key = generateAgentKey('TestAgent');
      const signed = signMessage('Hello world', key);
      signed.keyId = 'wrong-key-id';

      const result = verifyMessage(signed, key);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Key ID mismatch');
    });

    it('rejects expired key', () => {
      const key = generateAgentKey('TestAgent', 'hmac-sha256', -1);
      const signed = signMessage('Hello world', key);

      const result = verifyMessage(signed, key);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('expired');
    });
  });

  describe('verifyWithSharedSecret', () => {
    it('verifies valid signature', () => {
      const signed = signWithSharedSecret('Hello', 'TestAgent', 'secret');
      const result = verifyWithSharedSecret(signed, 'secret');

      expect(result.valid).toBe(true);
      expect(result.signer).toBe('TestAgent');
    });

    it('rejects wrong secret', () => {
      const signed = signWithSharedSecret('Hello', 'TestAgent', 'secret');
      const result = verifyWithSharedSecret(signed, 'wrong-secret');

      expect(result.valid).toBe(false);
    });
  });

  // ===========================================================================
  // Ed25519 Signing and Verification Tests
  // ===========================================================================

  describe('Ed25519 signing', () => {
    it('signs and verifies message with Ed25519', () => {
      const key = generateAgentKey('TestAgent', 'ed25519');
      const signed = signMessage('Hello world', key);

      expect(signed.algorithm).toBe('ed25519');
      expect(signed.signature).toBeDefined();
      expect(signed.signature.length).toBeGreaterThan(0);

      const result = verifyMessage(signed, key);
      expect(result.valid).toBe(true);
      expect(result.signer).toBe('TestAgent');
    });

    it('produces valid hex signatures', () => {
      const key = generateAgentKey('TestAgent', 'ed25519');
      const signed = signMessage('Test content', key);

      // Ed25519 signatures are 64 bytes = 128 hex chars
      expect(signed.signature).toMatch(/^[a-f0-9]+$/);
      expect(signed.signature.length).toBe(128);
    });

    it('rejects tampered content with Ed25519', () => {
      const key = generateAgentKey('TestAgent', 'ed25519');
      const signed = signMessage('Original content', key);
      signed.content = 'Tampered content';

      const result = verifyMessage(signed, key);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid signature');
    });

    it('rejects tampered signature with Ed25519', () => {
      const key = generateAgentKey('TestAgent', 'ed25519');
      const signed = signMessage('Hello', key);
      // Tamper with signature
      signed.signature = 'a'.repeat(128);

      const result = verifyMessage(signed, key);
      expect(result.valid).toBe(false);
    });

    it('signs messages consistently with same key', () => {
      const key = generateAgentKey('TestAgent', 'ed25519');
      const content = 'Test message';

      const signed1 = signMessage(content, key);
      const signed2 = signMessage(content, key);

      // Both should be verifiable
      expect(verifyMessage(signed1, key).valid).toBe(true);
      expect(verifyMessage(signed2, key).valid).toBe(true);
    });
  });

  describe('verifyEd25519WithPublicKey', () => {
    it('verifies signature with only public key (asymmetric verification)', () => {
      const key = generateAgentKey('TestAgent', 'ed25519');
      const signed = signMessage('Hello world', key);

      // Verify using only the public key (the main benefit of asymmetric signing)
      const result = verifyEd25519WithPublicKey(signed, key.publicKey, 'TestAgent');

      expect(result.valid).toBe(true);
      expect(result.signer).toBe('TestAgent');
    });

    it('rejects wrong algorithm', () => {
      const hmacKey = generateAgentKey('TestAgent', 'hmac-sha256');
      const signed = signMessage('Hello', hmacKey);

      const ed25519Key = generateAgentKey('TestAgent', 'ed25519');
      const result = verifyEd25519WithPublicKey(signed, ed25519Key.publicKey, 'TestAgent');

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Algorithm mismatch');
    });

    it('rejects wrong signer', () => {
      const key = generateAgentKey('TestAgent', 'ed25519');
      const signed = signMessage('Hello', key);

      const result = verifyEd25519WithPublicKey(signed, key.publicKey, 'WrongAgent');

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Signer mismatch');
    });

    it('rejects wrong public key', () => {
      const key1 = generateAgentKey('TestAgent', 'ed25519');
      const key2 = generateAgentKey('OtherAgent', 'ed25519');
      const signed = signMessage('Hello', key1);

      const result = verifyEd25519WithPublicKey(signed, key2.publicKey, 'TestAgent');

      expect(result.valid).toBe(false);
      // Will fail on key ID mismatch
      expect(result.error).toContain('Key ID mismatch');
    });

    it('enables zero-trust verification without private key', () => {
      // This is the key use case for Ed25519:
      // A verifier can check signatures without access to the private key

      const key = generateAgentKey('SecureAgent', 'ed25519');
      const signed = signMessage('Sensitive operation approved', key);

      // Extract only the public key (simulating distribution to verifiers)
      const publicKeyOnly = key.publicKey;

      // Verifier can validate without ever seeing the private key
      const result = verifyEd25519WithPublicKey(signed, publicKeyOnly, 'SecureAgent');
      expect(result.valid).toBe(true);
    });
  });

  // ===========================================================================
  // Signing Manager Tests
  // ===========================================================================

  describe('AgentSigningManager', () => {
    it('signs and verifies messages', () => {
      const manager = new AgentSigningManager(
        { enabled: true, algorithm: 'hmac-sha256', requireSignatures: false },
        tempDir
      );

      manager.registerAgent('TestAgent');
      const signed = manager.sign('TestAgent', 'Hello world');

      expect(signed).not.toBeNull();
      const result = manager.verify(signed!);
      expect(result.valid).toBe(true);
    });

    it('returns null when signing disabled', () => {
      const manager = new AgentSigningManager({ enabled: false, algorithm: 'hmac-sha256', requireSignatures: false });
      const signed = manager.sign('TestAgent', 'Hello');
      expect(signed).toBeNull();
    });

    it('accepts all messages when disabled', () => {
      const manager = new AgentSigningManager({ enabled: false, algorithm: 'hmac-sha256', requireSignatures: false });
      const mockSigned: SignedMessage = {
        content: 'Hello',
        signature: 'invalid',
        signer: 'Unknown',
        signedAt: Date.now(),
        keyId: 'invalid',
        algorithm: 'hmac-sha256',
      };

      const result = manager.verify(mockSigned);
      expect(result.valid).toBe(true);
    });

    it('uses shared secret when configured', () => {
      const manager = new AgentSigningManager(
        { enabled: true, algorithm: 'hmac-sha256', requireSignatures: false, sharedSecret: 'my-secret' },
        tempDir
      );

      const signed = manager.sign('TestAgent', 'Hello');
      expect(signed).not.toBeNull();

      const result = manager.verify(signed!);
      expect(result.valid).toBe(true);
    });

    it('allows unsigned from specific agents', () => {
      const manager = new AgentSigningManager({
        enabled: true,
        algorithm: 'hmac-sha256',
        requireSignatures: true,
        allowUnsignedFrom: ['TrustedAgent'],
      }, tempDir);

      const mockSigned: SignedMessage = {
        content: 'Hello',
        signature: 'invalid',
        signer: 'TrustedAgent',
        signedAt: Date.now(),
        keyId: 'invalid',
        algorithm: 'hmac-sha256',
      };

      const result = manager.verify(mockSigned);
      expect(result.valid).toBe(true);
    });

    it('rotates keys', () => {
      const manager = new AgentSigningManager(
        { enabled: true, algorithm: 'hmac-sha256', requireSignatures: false },
        tempDir
      );

      const originalKey = manager.registerAgent('TestAgent');
      const rotatedKey = manager.rotateKey('TestAgent');

      expect(rotatedKey.privateKey).not.toBe(originalKey.privateKey);
      expect(rotatedKey.publicKey).not.toBe(originalKey.publicKey);
    });

    it('exports public key', () => {
      const manager = new AgentSigningManager(
        { enabled: true, algorithm: 'hmac-sha256', requireSignatures: false },
        tempDir
      );

      manager.registerAgent('TestAgent');
      const exported = manager.exportPublicKey('TestAgent');

      expect(exported).not.toBeNull();
      expect(exported!.agentName).toBe('TestAgent');
      expect(exported!.publicKey).toBeDefined();
      expect(exported!.algorithm).toBe('hmac-sha256');
    });

    it('checks if verification is required', () => {
      const manager = new AgentSigningManager({
        enabled: true,
        algorithm: 'hmac-sha256',
        requireSignatures: true,
        allowUnsignedFrom: ['TrustedAgent'],
      }, tempDir);

      expect(manager.requiresVerification('RandomAgent')).toBe(true);
      expect(manager.requiresVerification('TrustedAgent')).toBe(false);
    });

    it('signs and verifies with Ed25519', () => {
      const manager = new AgentSigningManager(
        { enabled: true, algorithm: 'ed25519', requireSignatures: false },
        tempDir
      );

      manager.registerAgent('Ed25519Agent');
      const signed = manager.sign('Ed25519Agent', 'Secure message');

      expect(signed).not.toBeNull();
      expect(signed!.algorithm).toBe('ed25519');

      const result = manager.verify(signed!);
      expect(result.valid).toBe(true);
    });

    it('persists and loads Ed25519 keys', () => {
      const manager1 = new AgentSigningManager(
        { enabled: true, algorithm: 'ed25519', requireSignatures: false },
        tempDir
      );

      const originalKey = manager1.registerAgent('PersistentAgent');

      // Create new manager to load from disk
      const manager2 = new AgentSigningManager(
        { enabled: true, algorithm: 'ed25519', requireSignatures: false },
        tempDir
      );

      const loadedKey = manager2.getKey('PersistentAgent');
      expect(loadedKey).not.toBeNull();
      expect(loadedKey!.publicKey).toBe(originalKey.publicKey);
      expect(loadedKey!.privateKey).toBe(originalKey.privateKey);
    });
  });

  // ===========================================================================
  // Protocol Integration Tests
  // ===========================================================================

  describe('Protocol Integration', () => {
    it('attaches signature to envelope', () => {
      const key = generateAgentKey('TestAgent');
      const signed = signMessage('{"type":"SEND"}', key);

      const envelope = { type: 'SEND', from: 'TestAgent', payload: {} };
      const withSig = attachSignature(envelope, signed);

      expect(withSig._sig).toBeDefined();
      expect((withSig._sig as Record<string, unknown>).s).toBe(signed.signature);
      expect((withSig._sig as Record<string, unknown>).k).toBe(signed.keyId);
      expect((withSig._sig as Record<string, unknown>).t).toBe(signed.signedAt);
    });

    it('extracts signature from envelope', () => {
      const envelope = {
        type: 'SEND',
        from: 'TestAgent',
        payload: {},
        _sig: {
          s: 'signature-hex',
          k: 'key-id',
          t: Date.now(),
          a: 'hmac-sha256',
        },
      };

      const extracted = extractSignature(envelope);

      expect(extracted).not.toBeNull();
      expect(extracted!.signature).toBe('signature-hex');
      expect(extracted!.keyId).toBe('key-id');
      expect(extracted!.signer).toBe('TestAgent');
    });

    it('returns null for unsigned envelope', () => {
      const envelope = { type: 'SEND', from: 'TestAgent' };
      const extracted = extractSignature(envelope);
      expect(extracted).toBeNull();
    });
  });

  // ===========================================================================
  // Config Loading Tests
  // ===========================================================================

  describe('loadSigningConfig', () => {
    it('returns default config when no file exists', () => {
      const config = loadSigningConfig('/nonexistent/path');

      expect(config.enabled).toBe(false);
      expect(config.algorithm).toBe('hmac-sha256');
      expect(config.requireSignatures).toBe(false);
    });

    it('loads config from file', () => {
      const configPath = path.join(tempDir, 'signing.json');
      fs.writeFileSync(configPath, JSON.stringify({
        enabled: true,
        requireSignatures: true,
        sharedSecret: 'test-secret',
      }));

      const config = loadSigningConfig(configPath);

      expect(config.enabled).toBe(true);
      expect(config.requireSignatures).toBe(true);
      expect(config.sharedSecret).toBe('test-secret');
    });
  });
});
