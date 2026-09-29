import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { digestBytes, checksumNumber } from '../cmds/digest-algorithms.mjs';
import { createU2Context } from '../cmds/u2-common.mjs';
import { parseChecksumRecord } from '../cmds/checksum-manifest.mjs';

const context = (options = {}) => createU2Context({ command: 'digest-test', ...options });
const hex = (bytes) => Buffer.from(bytes).toString('hex');
test('MD5, SHA and BLAKE2b byte offsets and compression boundaries match independent Node crypto', async () => {
  for (const length of [0, 1, 55, 56, 63, 64, 65, 111, 112, 127, 128, 129, 255, 256, 1025]) {
    const backing = Uint8Array.from({ length: length + 9 }, (_, i) => (i * 37 + 191) % 256), bytes = backing.subarray(3, length + 3);
    for (const algorithm of ['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512', 'blake2b']) {
      const expected = createHash(algorithm === 'blake2b' ? 'blake2b512' : algorithm).update(bytes).digest('hex');
      assert.equal(hex(await digestBytes(algorithm, bytes, { context: context(), subtle: webcrypto.subtle })), expected, `${algorithm} length ${length}`);
    }
  }
});
test('legacy checksum fixed vectors distinguish length-folded CRC and reflected CRC32', async () => {
  const bytes = new TextEncoder().encode('123456789');
  for (const [algorithm, expected] of [['crc', 930766865], ['crc32b', 3421780262], ['bsd', 53615], ['sysv', 477]]) {
    assert.equal(await checksumNumber(algorithm, bytes, { context: context() }), expected, algorithm);
  }
  assert.equal(await checksumNumber('crc', new Uint8Array(), { context: context() }), 4294967295);
});
test('pure JavaScript algorithms enforce shared work and retention ceilings', async () => {
  for (const algorithm of ['md5', 'sha224', 'blake2b']) {
    await assert.rejects(digestBytes(algorithm, new Uint8Array(256), { context: context({ limits: { maxSteps: 1 } }) }), /resource limit/);
    await assert.rejects(digestBytes(algorithm, new Uint8Array(1), { context: context({ limits: { maxRetainedBytes: 0 } }) }), /retained/);
  }
});
test('WebCrypto failure, absence and malformed results refuse explicitly', async () => {
  await assert.rejects(digestBytes('sha256', new Uint8Array(), { context: context(), subtle: null }), /unavailable/);
  await assert.rejects(digestBytes('sha256', new Uint8Array(), { context: context(), subtle: { digest() { throw new Error('no provider'); } } }), /no provider/);
  await assert.rejects(digestBytes('sha256', new Uint8Array(), { context: context(), subtle: { async digest() { return new ArrayBuffer(31); } } }), /invalid digest/);
});
test('tagged manifest algorithms and BLAKE2b lengths are validated independently of digest execution', () => {
  assert.equal(parseChecksumRecord('MD5 (a) = d41d8cd98f00b204e9800998ecf8427e').algorithm, 'md5');
  assert.equal(parseChecksumRecord('MD5 (a) = d41d8cd98f00b204e9800998ecf8427e', { algorithm: 'sha1' }), null);
  assert.equal(parseChecksumRecord('BLAKE2b-8 (a) = 2e').bits, 8);
  assert.equal(parseChecksumRecord('BLAKE2b-9 (a) = 2e'), null);
  assert.equal(parseChecksumRecord('BLAKE2b (a) = 2e'), null);
  assert.equal(parseChecksumRecord('SHA256 (a) = 47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=', { allowBase64: true }).encoding, 'base64');
  assert.equal(parseChecksumRecord('d41d8cd98f00b204e9800998ecf8427e a', { algorithm: 'md5' }).name, 'a');
  assert.equal(parseChecksumRecord('\\d41d8cd98f00b204e9800998ecf8427e  bad\\q', { algorithm: 'md5' }), null);
});
