import assert from 'node:assert/strict';
import test from 'node:test';
import { readClientFrame } from './engine-fixture.mjs';

function maskedFrame(payload) {
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const header = Buffer.from([0x81, 0xfe, 0, payload.length]);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % mask.length];
  return Buffer.concat([header, mask, masked]);
}

test('accepts indicator 126 with a decoded 127-byte payload', () => {
  const payload = Buffer.alloc(127, 0x61);
  const frame = readClientFrame(maskedFrame(payload));
  assert(frame);
  assert.equal(frame.opcode, 1);
  assert.deepEqual(frame.data, payload);
  assert.equal(frame.rest.length, 0);
});

test('rejects the unsupported 64-bit length indicator', () => {
  assert.throws(() => readClientFrame(Buffer.from([0x81, 0xff])), /Unexpected oversized broker frame/);
});
