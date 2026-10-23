import { hmacSha256Hex } from './sha256.js';

export const CODE_PREFIX = 'WOL1-';
export const TOPIC_ROOT = 'wol';
export const DEFAULT_BROKER = {
  b: 'broker.emqx.io',
  p: 8883,
  w: 8084,
  path: '/mqtt',
  secure: true,
};

const CLAIM_WINDOW_SECONDS = 600;

export function isHex(value, length) {
  return typeof value === 'string' && value.length === length && /^[0-9a-fA-F]+$/.test(value);
}

export function normalizeMac(value) {
  const hex = String(value == null ? '' : value).replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g).join(':');
}

export function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj || typeof cryptoObj.getRandomValues !== 'function') {
    throw new Error('当前浏览器不支持安全随机数，请使用现代浏览器并通过 HTTPS 打开');
  }
  cryptoObj.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

export function bytesToBase64Url(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function textToBytes(value) {
  return new TextEncoder().encode(String(value));
}

function bytesToText(bytes) {
  return new TextDecoder().decode(bytes);
}

export function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const integer = Math.trunc(number);
  if (integer < min || integer > max) return fallback;
  return integer;
}

export function validateConfig(input) {
  if (!input || typeof input !== 'object') throw new Error('设备配置为空');
  if (Number(input.v) !== 1) throw new Error('设备码版本不正确');

  const broker = String(input.b || '').trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,61}[A-Za-z0-9])?$/.test(broker)) {
    throw new Error('Broker 地址不合法');
  }

  const mqttPort = clampInt(input.p, 1, 65535, 0);
  const wsPort = clampInt(input.w, 1, 65535, 0);
  if (!mqttPort) throw new Error('MQTT 端口不合法');
  if (!wsPort) throw new Error('WebSocket 端口不合法');

  const topicId = String(input.i || '').toLowerCase();
  if (!isHex(topicId, topicId.length) || topicId.length < 16 || topicId.length > 32) {
    throw new Error('Topic ID 必须是 16~32 位十六进制');
  }

  const secret = String(input.s || '').toLowerCase();
  if (!isHex(secret, 64)) throw new Error('密钥必须是 64 位十六进制');

  const macs = Array.isArray(input.m) ? input.m.map(normalizeMac) : [];
  if (!macs.length || macs.some((mac) => !mac)) throw new Error('至少需要一个合法 MAC 地址');
  if (macs.length > 3) throw new Error('最多支持 3 个 MAC 地址');
  if (new Set(macs).size !== macs.length) throw new Error('MAC 地址不能重复');

  const name = String(input.n || '').slice(0, 23);
  const user = String(input.u || '').slice(0, 32);
  const password = String(input.pw || '').slice(0, 32);
  const path = String(input.path || '/mqtt');
  if (!path.startsWith('/') || path.length > 32) throw new Error('WebSocket 路径不合法');

  return {
    v: 1,
    b: broker,
    p: mqttPort,
    w: wsPort,
    path,
    i: topicId,
    s: secret,
    m: macs,
    n: name,
    u: user,
    pw: password,
    secure: input.secure !== false,
  };
}

export function encodeDeviceCode(input) {
  const cfg = validateConfig(input);
  return CODE_PREFIX + bytesToBase64Url(textToBytes(JSON.stringify(cfg)));
}

export function decodeDeviceCode(code) {
  const raw = String(code || '').trim().replace(/\s+/g, '');
  if (!raw) throw new Error('请粘贴设备码');
  if (!raw.startsWith(CODE_PREFIX)) throw new Error('设备码应以 WOL1- 开头');
  let parsed;
  try {
    parsed = JSON.parse(bytesToText(base64UrlToBytes(raw.slice(CODE_PREFIX.length))));
  } catch (error) {
    throw new Error('设备码已损坏或复制不完整');
  }
  return validateConfig(parsed);
}

export function newConfig({ macs = [], name = '我的电脑', broker = DEFAULT_BROKER } = {}) {
  return validateConfig({
    v: 1,
    b: broker.b,
    p: broker.p,
    w: broker.w,
    path: broker.path,
    secure: broker.secure !== false,
    i: randomHex(16),
    s: randomHex(32),
    m: macs,
    n: name,
    u: broker.u || '',
    pw: broker.pw || '',
  });
}

export function topicFor(cfg, suffix) {
  return `${TOPIC_ROOT}/${cfg.i}/${suffix}`;
}

export function canonicalCommand(input) {
  const mac = input.mac || input.m;
  const nonce = input.nonce || input.n;
  const ts = input.ts;
  const id = input.id;
  if (!mac || !nonce || id == null || !Number.isFinite(Number(ts))) {
    throw new Error('命令字段不完整');
  }
  return `v1|wake|${mac}|${ts}|${nonce}|${id}`;
}

export function buildCommand(cfg, mac, options = {}) {
  const normalizedMac = normalizeMac(mac);
  if (!normalizedMac) throw new Error('MAC 地址不合法');
  if (!cfg.m.includes(normalizedMac)) throw new Error('该 MAC 不在设备允许列表中');

  const ts = Number.isFinite(options.ts) ? Math.trunc(options.ts) : Math.floor(Date.now() / 1000);
  const nonce = options.nonce || randomHex(8);
  const id = options.id || randomHex(4);
  const signature = hmacSha256Hex(cfg.s, canonicalCommand({ mac: normalizedMac, ts, nonce, id }));

  return {
    v: 1,
    a: 'wake',
    m: normalizedMac,
    ts,
    n: nonce,
    id,
    sig: signature,
  };
}

function timingSafeEqualHex(left, right) {
  const a = String(left || '').toLowerCase();
  const b = String(right || '').toLowerCase();
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function verifyCommand(cfg, payload, options = {}) {
  const now = Number.isFinite(options.now) ? Math.trunc(options.now) : Math.floor(Date.now() / 1000);
  const window = Number.isFinite(options.window) ? options.window : CLAIM_WINDOW_SECONDS;
  const seen = options.seenNonces;
  const requireTime = options.requireTime !== false;

  if (!payload || typeof payload !== 'object') return { ok: false, error: 'json' };
  if (Number(payload.v) !== 1 || payload.a !== 'wake') return { ok: false, error: 'command' };

  const mac = normalizeMac(payload.m);
  if (!mac) return { ok: false, error: 'mac' };
  if (Array.isArray(cfg.m) && cfg.m.length && !cfg.m.includes(mac)) return { ok: false, error: 'mac' };

  const ts = Number(payload.ts);
  const nonce = String(payload.n || '');
  const id = String(payload.id || '');
  if (!Number.isInteger(ts) || ts <= 0) return { ok: false, error: 'time' };
  if (!isHex(nonce, nonce.length) || nonce.length < 8 || nonce.length > 32) {
    return { ok: false, error: 'nonce' };
  }
  if (!isHex(id, 8)) return { ok: false, error: 'id' };
  if (!isHex(payload.sig, 64)) return { ok: false, error: 'sig' };

  if (requireTime && Math.abs(now - ts) > window) return { ok: false, error: 'time' };
  if (seen) {
    if (typeof seen.has === 'function' && seen.has(nonce)) return { ok: false, error: 'replay' };
    if (Array.isArray(seen) && seen.includes(nonce)) return { ok: false, error: 'replay' };
  }

  const expected = hmacSha256Hex(cfg.s, canonicalCommand({ mac, ts, nonce, id }));
  if (!timingSafeEqualHex(expected, payload.sig)) return { ok: false, error: 'sig' };

  return { ok: true, mac, ts, nonce, id };
}

export function brokerUrl(cfg) {
  const scheme = cfg.secure === false ? 'ws' : 'wss';
  const path = cfg.path && cfg.path.startsWith('/') ? cfg.path : '/mqtt';
  return `${scheme}://${cfg.b}:${cfg.w}${path}`;
}

export function newClientId() {
  return `wol-web-${randomHex(4)}`;
}

export function formatClock(ts) {
  if (!ts) return '从未';
  const date = new Date(ts * 1000);
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}

export function relativeTime(ts) {
  if (!ts) return '从未';
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - Number(ts));
  if (seconds < 5) return '刚刚';
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

export const protocolConstants = {
  claimWindowSeconds: CLAIM_WINDOW_SECONDS,
  topicRoot: TOPIC_ROOT,
  codePrefix: CODE_PREFIX,
};
