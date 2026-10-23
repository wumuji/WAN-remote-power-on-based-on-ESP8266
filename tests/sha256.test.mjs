import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sha256Hex, hmacSha256Hex, hmacSha256, toHex } from '../web/js/sha256.js';

test('SHA-256 已知向量', () => {
  assert.equal(
    sha256Hex(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  assert.equal(
    sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.equal(
    sha256Hex('The quick brown fox jumps over the lazy dog'),
    'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
  );
});

test('SHA-256 与 Node crypto 一致', () => {
  for (let i = 0; i < 40; i += 1) {
    const text = crypto.randomBytes(i * 3).toString('base64') + '中文' + i;
    const expected = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
    assert.equal(sha256Hex(text), expected, `length=${text.length}`);
  }
});

test('HMAC-SHA256 RFC 4231 向量', () => {
  const key1 = new Uint8Array(20).fill(0x0b);
  assert.equal(
    hmacSha256Hex(key1, 'Hi There'),
    'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
  );
  assert.equal(
    hmacSha256Hex('Jefe', 'what do ya want for nothing?'),
    '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
  );
  const key3 = new Uint8Array(20).fill(0xaa);
  const data3 = new Uint8Array(50).fill(0xdd);
  assert.equal(
    toHex(hmacSha256(key3, data3)),
    '773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe',
  );
  const longKey = new Uint8Array(131).fill(0xaa);
  assert.equal(
    hmacSha256Hex(longKey, 'Test Using Larger Than Block-Size Key - Hash Key First'),
    '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54',
  );
});

test('HMAC 与 Node crypto 一致（含中文/长 key）', () => {
  for (let i = 0; i < 20; i += 1) {
    const key = i % 3 === 0 ? crypto.randomBytes(80).toString('hex') : `secret-${i}-中文`;
    const message = `v1|wake|AA:BB:CC:DD:EE:FF|${1700000000 + i}|abcdef0123456789|deadbeef`;
    const expected = crypto.createHmac('sha256', Buffer.from(key, 'utf8')).update(message, 'utf8').digest('hex');
    assert.equal(hmacSha256Hex(key, message), expected);
  }
});
