/**
 * Gravatar URL utilities
 *
 * Constructs Gravatar URLs from email addresses using MD5 hashing.
 * Used as a fallback when explicit avatarUrl is not available.
 */

/**
 * Compute MD5 hash of a string.
 * Lightweight implementation for Gravatar URL construction.
 */
function md5(input: string): string {
  // Pre-computed constants
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];

  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    K[i] = Math.floor(2 ** 32 * Math.abs(Math.sin(i + 1)));
  }

  // Convert string to UTF-8 byte array
  const encoder = new TextEncoder();
  const messageBytes = encoder.encode(input);
  const messageLenBits = messageBytes.length * 8;

  // Padding: append 1 bit, then zeros, then 64-bit length
  const padLen = (((55 - messageBytes.length) % 64) + 64) % 64;
  const padded = new Uint8Array(messageBytes.length + 1 + padLen + 8);
  padded.set(messageBytes);
  padded[messageBytes.length] = 0x80;

  // Append length in bits as 64-bit little-endian
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, messageLenBits >>> 0, true);
  view.setUint32(padded.length - 4, 0, true);

  // Initialize hash
  let a0 = 0x67452301 >>> 0;
  let b0 = 0xefcdab89 >>> 0;
  let c0 = 0x98badcfe >>> 0;
  let d0 = 0x10325476 >>> 0;

  // Process each 64-byte chunk
  for (let offset = 0; offset < padded.length; offset += 64) {
    const M = new Uint32Array(16);
    for (let j = 0; j < 16; j++) {
      M[j] = view.getUint32(offset + j * 4, true);
    }

    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;

    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;

      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }

      F = (F + A + K[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) >>> 0;
    }

    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  // Convert to hex string (little-endian)
  function toHex(n: number): string {
    const bytes = [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];
    return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  return toHex(a0) + toHex(b0) + toHex(c0) + toHex(d0);
}

/**
 * Get a Gravatar URL for an email address.
 *
 * @param email - User email address
 * @param size - Avatar size in pixels (default: 80)
 * @returns Gravatar URL with identicon fallback
 */
export function getGravatarUrl(email: string, size = 80): string {
  const hash = md5(email.trim().toLowerCase());
  return `https://www.gravatar.com/avatar/${hash}?d=identicon&s=${size}`;
}

/**
 * Get the best available avatar URL for a user.
 *
 * Priority:
 * 1. Explicit avatarUrl (e.g., from GitHub)
 * 2. Gravatar URL computed from email
 * 3. undefined (caller uses initial-letter fallback)
 *
 * @param opts - Avatar options
 * @returns Avatar URL or undefined
 */
export function getAvatarUrl(opts: {
  avatarUrl?: string;
  email?: string;
  size?: number;
}): string | undefined {
  if (opts.avatarUrl) {
    return opts.avatarUrl;
  }
  if (opts.email) {
    return getGravatarUrl(opts.email, opts.size);
  }
  return undefined;
}
