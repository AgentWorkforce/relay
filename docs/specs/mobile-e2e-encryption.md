# End-to-End Encryption - Implementation Spec

**Bead:** `bd-mobile-e2e`
**Priority:** P0 (Critical)
**Estimated Effort:** 1 week

## Overview

Implement E2E encryption so the relay server (daemon) never sees plaintext messages. This is critical for:
- Enterprise adoption (sensitive IP)
- Self-hosted deployments (trust)
- Competitive differentiation

---

## Threat Model

### What We Protect Against
- Server compromise (daemon or cloud)
- Man-in-the-middle attacks
- Message interception on network
- Database leaks

### What We Don't Protect Against
- Compromised client device
- Malicious agents on same machine
- Side-channel attacks

---

## Cryptographic Design

### Key Types

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Key Hierarchy                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Device Key Pair (Ed25519)                                              │
│  ├── Generated once per device                                           │
│  ├── Private key: Stored in secure enclave                              │
│  └── Public key: Shared with server for routing                         │
│                                                                          │
│  Session Key (X25519)                                                    │
│  ├── Derived per session via Diffie-Hellman                             │
│  └── Used for symmetric encryption                                       │
│                                                                          │
│  Message Key (XChaCha20-Poly1305)                                       │
│  ├── Derived per message from session key                                │
│  └── Ensures forward secrecy                                             │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Encryption Flow

```
Sender (Desktop)                    Server                    Receiver (Mobile)
      │                               │                              │
      │ 1. Generate keypair           │                              │
      │    (or load existing)         │                              │
      │                               │                              │
      │ 2. Get receiver's             │                              │
      │    public key ───────────────▶│◀────────────────────────────│
      │                               │  (public keys registered)    │
      │                               │                              │
      │ 3. Create shared secret       │                              │
      │    (X25519 DH)                │                              │
      │                               │                              │
      │ 4. Encrypt message            │                              │
      │    (XChaCha20-Poly1305)       │                              │
      │                               │                              │
      │ 5. Send encrypted ───────────▶│                              │
      │    blob + nonce               │                              │
      │                               │                              │
      │                               │ 6. Route to receiver         │
      │                               │    (cannot decrypt) ────────▶│
      │                               │                              │
      │                               │                 7. Decrypt   │
      │                               │                    with      │
      │                               │                    shared    │
      │                               │                    secret    │
```

---

## Implementation

### 1. Crypto Module (`src/mobile/crypto/`)

#### `keypair.ts` - Key Generation

```typescript
import sodium from 'libsodium-wrappers';

export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export async function generateKeyPair(): Promise<KeyPair> {
  await sodium.ready;

  // Generate Ed25519 keypair for signing/identity
  const signKp = sodium.crypto_sign_keypair();

  // Convert to X25519 for encryption
  const publicKey = sodium.crypto_sign_ed25519_pk_to_curve25519(signKp.publicKey);
  const secretKey = sodium.crypto_sign_ed25519_sk_to_curve25519(signKp.privateKey);

  return { publicKey, secretKey };
}

export function publicKeyToHex(publicKey: Uint8Array): string {
  return sodium.to_hex(publicKey);
}

export function hexToPublicKey(hex: string): Uint8Array {
  return sodium.from_hex(hex);
}
```

#### `keystore.ts` - Secure Storage

```typescript
import * as Keychain from 'react-native-keychain';
import sodium from 'libsodium-wrappers';
import { KeyPair, generateKeyPair, publicKeyToHex } from './keypair';

const KEY_SERVICE = 'com.agentrelay.mobile';
const KEY_ACCOUNT = 'device_keypair';

export async function getOrCreateKeyPair(): Promise<KeyPair> {
  await sodium.ready;

  // Try to load existing
  const existing = await loadKeyPair();
  if (existing) return existing;

  // Generate new
  const keyPair = await generateKeyPair();
  await saveKeyPair(keyPair);

  return keyPair;
}

async function loadKeyPair(): Promise<KeyPair | null> {
  try {
    const credentials = await Keychain.getGenericPassword({
      service: KEY_SERVICE,
    });

    if (!credentials) return null;

    const data = JSON.parse(credentials.password);
    return {
      publicKey: sodium.from_hex(data.publicKey),
      secretKey: sodium.from_hex(data.secretKey),
    };
  } catch {
    return null;
  }
}

async function saveKeyPair(keyPair: KeyPair): Promise<void> {
  const data = JSON.stringify({
    publicKey: publicKeyToHex(keyPair.publicKey),
    secretKey: sodium.to_hex(keyPair.secretKey),
  });

  await Keychain.setGenericPassword(KEY_ACCOUNT, data, {
    service: KEY_SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    // Use secure enclave on iOS
    accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_CURRENT_SET_OR_DEVICE_PASSCODE,
  });
}

export async function wipeKeyPair(): Promise<void> {
  await Keychain.resetGenericPassword({ service: KEY_SERVICE });
}
```

#### `encrypt.ts` - Message Encryption

```typescript
import sodium from 'libsodium-wrappers';

export interface EncryptedMessage {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  senderPublicKey: Uint8Array;
}

/**
 * Encrypt a message for a specific recipient
 * Uses authenticated encryption (XChaCha20-Poly1305)
 */
export async function encryptMessage(
  plaintext: string | Uint8Array,
  recipientPublicKey: Uint8Array,
  senderSecretKey: Uint8Array,
  senderPublicKey: Uint8Array
): Promise<EncryptedMessage> {
  await sodium.ready;

  // Convert string to bytes if needed
  const message = typeof plaintext === 'string'
    ? sodium.from_string(plaintext)
    : plaintext;

  // Generate random nonce
  const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);

  // Encrypt with authenticated encryption
  const ciphertext = sodium.crypto_box_easy(
    message,
    nonce,
    recipientPublicKey,
    senderSecretKey
  );

  return {
    ciphertext,
    nonce,
    senderPublicKey,
  };
}

/**
 * Encrypt for anonymous recipient (sealed box)
 * Recipient can decrypt but sender is anonymous
 */
export async function encryptSealed(
  plaintext: string | Uint8Array,
  recipientPublicKey: Uint8Array
): Promise<Uint8Array> {
  await sodium.ready;

  const message = typeof plaintext === 'string'
    ? sodium.from_string(plaintext)
    : plaintext;

  return sodium.crypto_box_seal(message, recipientPublicKey);
}

/**
 * Serialize encrypted message for transport
 */
export function serializeEncrypted(msg: EncryptedMessage): string {
  return JSON.stringify({
    c: sodium.to_base64(msg.ciphertext),
    n: sodium.to_base64(msg.nonce),
    pk: sodium.to_base64(msg.senderPublicKey),
  });
}
```

#### `decrypt.ts` - Message Decryption

```typescript
import sodium from 'libsodium-wrappers';
import { EncryptedMessage } from './encrypt';

/**
 * Decrypt a message from a known sender
 */
export async function decryptMessage(
  encrypted: EncryptedMessage,
  recipientSecretKey: Uint8Array
): Promise<Uint8Array> {
  await sodium.ready;

  const plaintext = sodium.crypto_box_open_easy(
    encrypted.ciphertext,
    encrypted.nonce,
    encrypted.senderPublicKey,
    recipientSecretKey
  );

  if (!plaintext) {
    throw new Error('Decryption failed - invalid ciphertext or wrong key');
  }

  return plaintext;
}

/**
 * Decrypt a sealed box (anonymous sender)
 */
export async function decryptSealed(
  ciphertext: Uint8Array,
  recipientPublicKey: Uint8Array,
  recipientSecretKey: Uint8Array
): Promise<Uint8Array> {
  await sodium.ready;

  const plaintext = sodium.crypto_box_seal_open(
    ciphertext,
    recipientPublicKey,
    recipientSecretKey
  );

  if (!plaintext) {
    throw new Error('Decryption failed');
  }

  return plaintext;
}

/**
 * Deserialize and decrypt a transport message
 */
export async function deserializeAndDecrypt(
  serialized: string,
  recipientSecretKey: Uint8Array
): Promise<string> {
  await sodium.ready;

  const data = JSON.parse(serialized);
  const encrypted: EncryptedMessage = {
    ciphertext: sodium.from_base64(data.c),
    nonce: sodium.from_base64(data.n),
    senderPublicKey: sodium.from_base64(data.pk),
  };

  const plaintext = await decryptMessage(encrypted, recipientSecretKey);
  return sodium.to_string(plaintext);
}
```

---

### 2. Key Exchange Protocol

```typescript
// src/mobile/crypto/key-exchange.ts

import sodium from 'libsodium-wrappers';

/**
 * Perform key exchange between two parties
 * Returns shared secret for symmetric encryption
 */
export async function deriveSharedSecret(
  ourSecretKey: Uint8Array,
  theirPublicKey: Uint8Array
): Promise<Uint8Array> {
  await sodium.ready;

  // X25519 key exchange
  const sharedSecret = sodium.crypto_scalarmult(ourSecretKey, theirPublicKey);

  // Derive key using BLAKE2b
  return sodium.crypto_generichash(32, sharedSecret);
}

/**
 * Derive session keys from shared secret
 * Creates separate keys for sending and receiving
 */
export async function deriveSessionKeys(
  sharedSecret: Uint8Array,
  isInitiator: boolean
): Promise<{ sendKey: Uint8Array; recvKey: Uint8Array }> {
  await sodium.ready;

  // Use different salts for each direction
  const salt1 = sodium.from_string('relay-session-key-1');
  const salt2 = sodium.from_string('relay-session-key-2');

  const key1 = sodium.crypto_generichash(32, new Uint8Array([...sharedSecret, ...salt1]));
  const key2 = sodium.crypto_generichash(32, new Uint8Array([...sharedSecret, ...salt2]));

  // Initiator uses key1 for sending, key2 for receiving
  // Responder uses key2 for sending, key1 for receiving
  return isInitiator
    ? { sendKey: key1, recvKey: key2 }
    : { sendKey: key2, recvKey: key1 };
}
```

---

### 3. Integration with Sync

```typescript
// src/mobile/sync.ts (updated)

import { getOrCreateKeyPair } from './crypto/keystore';
import { encryptMessage, serializeEncrypted } from './crypto/encrypt';
import { deserializeAndDecrypt } from './crypto/decrypt';
import { deriveSharedSecret, deriveSessionKeys } from './crypto/key-exchange';

export class SecureSessionSync {
  private keyPair: KeyPair | null = null;
  private sessionKeys: { sendKey: Uint8Array; recvKey: Uint8Array } | null = null;
  private peerPublicKey: Uint8Array | null = null;

  async initialize(): Promise<void> {
    // Load or create our keypair
    this.keyPair = await getOrCreateKeyPair();
  }

  async establishSession(peerPublicKey: Uint8Array): Promise<void> {
    if (!this.keyPair) throw new Error('Not initialized');

    this.peerPublicKey = peerPublicKey;

    // Derive shared secret
    const sharedSecret = await deriveSharedSecret(
      this.keyPair.secretKey,
      peerPublicKey
    );

    // Derive session keys
    this.sessionKeys = await deriveSessionKeys(
      sharedSecret,
      true // we are initiator
    );
  }

  async sendSecure(message: unknown): Promise<void> {
    if (!this.keyPair || !this.peerPublicKey) {
      throw new Error('Session not established');
    }

    const plaintext = JSON.stringify(message);

    const encrypted = await encryptMessage(
      plaintext,
      this.peerPublicKey,
      this.keyPair.secretKey,
      this.keyPair.publicKey
    );

    const serialized = serializeEncrypted(encrypted);

    // Send over WebSocket
    this.socket?.emit('encrypted', serialized);
  }

  async receiveSecure(serialized: string): Promise<unknown> {
    if (!this.keyPair) {
      throw new Error('Not initialized');
    }

    const plaintext = await deserializeAndDecrypt(
      serialized,
      this.keyPair.secretKey
    );

    return JSON.parse(plaintext);
  }

  getPublicKey(): Uint8Array | null {
    return this.keyPair?.publicKey ?? null;
  }
}
```

---

### 4. Server-Side Changes

The server (daemon) only routes encrypted blobs. It stores:
- Public keys for routing
- Encrypted messages (opaque blobs)
- Metadata (timestamps, sender ID, recipient ID)

```typescript
// src/daemon/encrypted-router.ts

interface EncryptedEnvelope {
  from: string;           // Sender's public key (hex)
  to: string;             // Recipient's public key (hex)
  payload: string;        // Encrypted, base64-encoded blob
  timestamp: number;
}

class EncryptedRouter {
  private publicKeyToConnection: Map<string, Connection> = new Map();

  registerPublicKey(publicKey: string, connection: Connection): void {
    this.publicKeyToConnection.set(publicKey, connection);
  }

  route(envelope: EncryptedEnvelope): void {
    const connection = this.publicKeyToConnection.get(envelope.to);

    if (connection) {
      // Forward encrypted blob - we cannot read it
      connection.send({
        type: 'encrypted',
        from: envelope.from,
        payload: envelope.payload,
        timestamp: envelope.timestamp,
      });
    } else {
      // Store for later delivery
      this.storeForLater(envelope);
    }
  }

  private storeForLater(envelope: EncryptedEnvelope): void {
    // Store encrypted - we never decrypt
    db.insert('pending_messages', {
      recipient_key: envelope.to,
      encrypted_payload: envelope.payload,
      timestamp: envelope.timestamp,
    });
  }
}
```

---

## Security Considerations

### Key Rotation

```typescript
// Rotate keys periodically for forward secrecy
async function rotateKeys(): Promise<void> {
  const oldKeyPair = await loadKeyPair();
  const newKeyPair = await generateKeyPair();

  // Notify peers of new public key
  await broadcastKeyRotation(oldKeyPair.publicKey, newKeyPair.publicKey);

  // Save new keypair
  await saveKeyPair(newKeyPair);

  // Securely wipe old key
  sodium.memzero(oldKeyPair.secretKey);
}
```

### Secure Memory

```typescript
// Wipe sensitive data when done
function cleanup(secretKey: Uint8Array): void {
  sodium.memzero(secretKey);
}
```

### No Plaintext Logging

```typescript
// NEVER log decrypted content
function logMessage(msg: EncryptedMessage): void {
  console.log(`Message from ${msg.senderPublicKey.slice(0, 8)}... (encrypted)`);
  // DO NOT: console.log(decryptedContent)
}
```

---

## File Structure

```
src/mobile/crypto/
├── index.ts          # Crypto exports
├── keypair.ts        # Key generation
├── keystore.ts       # Secure storage (Keychain/Keystore)
├── encrypt.ts        # Encryption functions
├── decrypt.ts        # Decryption functions
├── key-exchange.ts   # Session key derivation
└── utils.ts          # Encoding utilities

src/daemon/
└── encrypted-router.ts  # Server-side encrypted routing
```

---

## Dependencies

```json
{
  "dependencies": {
    "libsodium-wrappers": "^0.7.13",
    "react-native-keychain": "^8.2.0"
  }
}
```

For CLI (Node.js):
```json
{
  "dependencies": {
    "libsodium-wrappers": "^0.7.13"
  }
}
```

---

## Testing

### Unit Tests

```typescript
describe('Encryption', () => {
  it('should encrypt and decrypt message', async () => {
    const alice = await generateKeyPair();
    const bob = await generateKeyPair();

    const plaintext = 'Hello, Bob!';
    const encrypted = await encryptMessage(
      plaintext,
      bob.publicKey,
      alice.secretKey,
      alice.publicKey
    );

    const decrypted = await decryptMessage(encrypted, bob.secretKey);
    expect(sodium.to_string(decrypted)).toBe(plaintext);
  });

  it('should fail with wrong key', async () => {
    const alice = await generateKeyPair();
    const bob = await generateKeyPair();
    const eve = await generateKeyPair();

    const encrypted = await encryptMessage(
      'Secret',
      bob.publicKey,
      alice.secretKey,
      alice.publicKey
    );

    await expect(
      decryptMessage(encrypted, eve.secretKey)
    ).rejects.toThrow('Decryption failed');
  });
});
```

### Integration Tests

- Key exchange between CLI and mobile
- Message round-trip through daemon
- Key rotation workflow

---

## Rollout Plan

**Phase 1: Core Crypto (3 days)**
- [ ] Implement keypair generation
- [ ] Implement encrypt/decrypt
- [ ] Unit tests

**Phase 2: Keystore (2 days)**
- [ ] iOS Keychain integration
- [ ] Android Keystore integration
- [ ] Key loading/saving

**Phase 3: Integration (2 days)**
- [ ] Update sync to use encryption
- [ ] Update daemon routing
- [ ] E2E tests

**Phase 4: Key Management (1 day)**
- [ ] Key rotation
- [ ] Secure wipe on logout
- [ ] Documentation
