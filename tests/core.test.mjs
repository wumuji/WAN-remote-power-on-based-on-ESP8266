import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CODE_PREFIX,
  base64UrlToBytes,
  brokerUrl,
  buildCommand,
  bytesToBase64Url,
  canonicalCommand,
  decodeDeviceCode,
  encodeDeviceCode,
  normalizeMac,
  topicFor,
  validateConfig,
  verifyCommand,
} from '../web/js/core.js';

const CFG = validateConfig({
  v: 1,
  b: 'broker.emqx.io',
  p: 8883,
  w: 8084,
  path: '/mqtt',
  i: '0123456789abcdef0123456789abcdef',
  s: 'a'.repeat(64),
  m: ['AA:BB:CC:DD:EE:FF', '11-22-33-44-55-66'],
  n: '书房电脑',
  u: '',
  pw: '',
  secure: true,
});

test('MAC 归一化', () => {
  assert.equal(normalizeMac('aa-bb-cc-dd-ee-ff'), 'AA:BB:CC:DD:EE:FF');
  assert.equal(normalizeMac('aabbccddeeff'), 'AA:BB:CC:DD:EE:FF');
  assert.equal(normalizeMac('AA:BB:CC:DD:EE'), null);
  assert.equal(normalizeMac('ZZ:BB:CC:DD:EE:FF'), null);
});

test('base64url 往返', () => {
  const bytes = new TextEncoder().encode('你好，WOL-8266!');
  const decoded = new TextDecoder().decode(base64UrlToBytes(bytesToBase64Url(bytes)));
  assert.equal(decoded, '你好，WOL-8266!');
});

test('设备码编解码往返', () => {
  const code = encodeDeviceCode(CFG);
  assert.ok(code.startsWith(CODE_PREFIX));
  assert.match(code, /^WOL1-[A-Za-z0-9_-]+$/);
  const decoded = decodeDeviceCode(code);
  assert.deepEqual(decoded, CFG);
});

test('设备码校验拒绝被篡改内容', () => {
  assert.throws(() => decodeDeviceCode('WOL1-abc'), /损坏|不完整/);
  assert.throws(() => decodeDeviceCode('NOPE'), /WOL1-/);
  assert.throws(
    () => validateConfig({ ...CFG, m: ['not-a-mac'] }),
    /MAC/,
  );
  assert.throws(() => validateConfig({ ...CFG, s: 'short' }), /密钥/);
  assert.throws(() => validateConfig({ ...CFG, i: 'xyz' }), /Topic/);
});

test('命令签名与验证', () => {
  const command = buildCommand(CFG, 'aa-bb-cc-dd-ee-ff', {
    ts: 1700000000,
    nonce: '0123456789abcdef',
    id: 'deadbeef',
  });
  assert.equal(command.v, 1);
  assert.equal(command.a, 'wake');
  assert.equal(command.m, 'AA:BB:CC:DD:EE:FF');
  assert.equal(
    canonicalCommand(command),
    'v1|wake|AA:BB:CC:DD:EE:FF|1700000000|0123456789abcdef|deadbeef',
  );
  assert.match(command.sig, /^[0-9a-f]{64}$/);

  const ok = verifyCommand(CFG, command, { now: 1700000000 });
  assert.equal(ok.ok, true);
  assert.equal(ok.mac, 'AA:BB:CC:DD:EE:FF');
});

test('命令验证拒绝错误密钥、过期、重放与非法 MAC', () => {
  const command = buildCommand(CFG, 'AA:BB:CC:DD:EE:FF', {
    ts: 1700000000,
    nonce: '0123456789abcdef',
    id: 'deadbeef',
  });

  const wrongKey = { ...CFG, s: 'b'.repeat(64) };
  assert.equal(verifyCommand(wrongKey, command, { now: 1700000000 }).error, 'sig');

  const badSig = { ...command, sig: '0'.repeat(64) };
  assert.equal(verifyCommand(CFG, badSig, { now: 1700000000 }).error, 'sig');

  assert.equal(verifyCommand(CFG, command, { now: 1700009999 }).error, 'time');
  assert.equal(
    verifyCommand(CFG, command, { now: 1700000000, seenNonces: new Set(['0123456789abcdef']) }).error,
    'replay',
  );

  const cfgWithExtraMac = { ...CFG, m: [...CFG.m, 'AA:BB:CC:DD:EE:01'] };
  const otherMac = buildCommand(cfgWithExtraMac, 'AA:BB:CC:DD:EE:01', {
    ts: 1700000000,
    nonce: 'fedcba9876543210',
    id: 'cafebabe',
  });
  assert.equal(verifyCommand(CFG, otherMac, { now: 1700000000 }).error, 'mac');
});

test('Broker URL 与 Topic', () => {
  assert.equal(brokerUrl(CFG), 'wss://broker.emqx.io:8084/mqtt');
  assert.equal(brokerUrl({ ...CFG, secure: false, w: 8083 }), 'ws://broker.emqx.io:8083/mqtt');
  assert.equal(topicFor(CFG, 'cmd'), `wol/${CFG.i}/cmd`);
  assert.equal(topicFor(CFG, 'ack'), `wol/${CFG.i}/ack`);
  assert.equal(topicFor(CFG, 'status'), `wol/${CFG.i}/status`);
});
