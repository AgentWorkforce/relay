// jose@^6 ships only a webapi build and requires globalThis.crypto. Node 18
// gates this behind --experimental-global-webcrypto, so expose it explicitly.
import { webcrypto } from 'node:crypto';

const target = globalThis as Record<string, unknown>;
if (typeof target.crypto === 'undefined') {
  target.crypto = webcrypto;
}
