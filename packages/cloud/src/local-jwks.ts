import { createHash, createPrivateKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { createServer as createHttpServer, type Server } from 'node:http';

export const RELAYAUTH_JWKS_URL_ENV = 'RELAYAUTH_JWKS_URL';
export const RELAYAUTH_JWT_PRIVATE_KEY_PEM_ENV = 'RELAYAUTH_JWT_PRIVATE_KEY_PEM';
export const RELAYAUTH_JWT_KID_ENV = 'RELAYAUTH_JWT_KID';

export interface RsaPublicJwk {
  kty: string;
  n: string;
  e: string;
}

export interface LocalJwksSigningKey {
  privateKey: KeyObject;
  kid: string;
}

export interface LocalJwksKeyPair extends LocalJwksSigningKey {
  publicJwk: RsaPublicJwk;
}

export interface LocalJwks extends LocalJwksKeyPair {
  jwksUrl: string;
  shutdown: () => Promise<void>;
}

export function createLocalJwksKeyPair(): LocalJwksKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicJwk = publicKey.export({ format: 'jwk' }) as RsaPublicJwk;
  const kid = createHash('sha256')
    .update(JSON.stringify({ e: publicJwk.e, kty: 'RSA', n: publicJwk.n }))
    .digest('base64url');

  return { privateKey, publicJwk, kid };
}

export function exportPrivateKeyPem(privateKey: KeyObject): string {
  return privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
}

export function importPrivateKeyPem(privateKeyPem: string): KeyObject {
  return createPrivateKey(privateKeyPem);
}

export async function createLocalJwks(): Promise<LocalJwks> {
  const keyPair = createLocalJwksKeyPair();
  const jwk = {
    ...keyPair.publicJwk,
    kty: 'RSA',
    alg: 'RS256',
    use: 'sig',
    kid: keyPair.kid,
  };
  const server = createHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('local JWKS server did not bind to a TCP port');
  }

  server.unref();
  let closed = false;
  return {
    ...keyPair,
    jwksUrl: `http://127.0.0.1:${address.port}/.well-known/jwks.json`,
    shutdown: async () => {
      if (closed) {
        return;
      }
      closed = true;
      await closeServer(server);
    },
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
