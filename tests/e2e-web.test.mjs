import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import mqtt from 'mqtt';
import { Aedes } from 'aedes';
import { WebSocketServer, createWebSocketStream } from 'ws';
import { validateConfig, verifyCommand } from '../web/js/core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const CHROME = [
  process.env.WOL_BROWSER,
  path.join(ROOT, 'tools/.tools/chrome/chrome-win64/chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].filter(Boolean).find((candidate) => fs.existsSync(candidate));
const TMP = path.join(ROOT, 'tests/.tmp');
fs.mkdirSync(TMP, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json; charset=utf-8',
};

function staticServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      let filePath = path.join(WEB, decodeURIComponent(url.pathname));
      if (url.pathname === '/' || url.pathname.endsWith('/')) filePath = path.join(filePath, 'index.html');
      const relative = path.relative(WEB, filePath);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const data = await fsp.readFile(filePath);
      res.writeHead(200, {
        'content-type': MIME[path.extname(filePath)] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(data);
    } catch (error) {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function tcpBroker(broker) {
  const server = net.createServer(broker.handle);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function wsBroker(broker) {
  const wss = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    path: '/mqtt',
    handleProtocols: (protocols) => (protocols.has('mqtt') ? 'mqtt' : false),
  });
  wss.on('connection', (ws) => {
    broker.handle(createWebSocketStream(ws));
  });
  return new Promise((resolve) => wss.once('listening', () => resolve(wss)));
}

test('网页端到端：连接本地 Broker、设备在线、点击开机收到 ack',
  { skip: CHROME ? false : 'Chrome not found (set WOL_BROWSER)' },
  async (t) => {
  const aedesBroker = await Aedes.createBroker();
  const tcp = await tcpBroker(aedesBroker);
  const wss = await wsBroker(aedesBroker);
  const httpServer = await staticServer();

  const webPort = httpServer.address().port;
  const wsPort = wss.address().port;
  const tcpPort = tcp.address().port;

  const cfg = validateConfig({
    v: 1,
    b: '127.0.0.1',
    p: tcpPort,
    w: wsPort,
    path: '/mqtt',
    i: '0123456789abcdef0123456789abcdef',
    s: 'a'.repeat(64),
    m: ['AA:BB:CC:DD:EE:FF'],
    n: '厨房电脑',
    u: '',
    pw: '',
    secure: false,
  });

  const received = [];
  const device = mqtt.connect(`mqtt://127.0.0.1:${tcpPort}`, {
    clientId: 'mock-device',
    protocolVersion: 4,
    clean: true,
  });
  await new Promise((resolve, reject) => {
    device.once('connect', resolve);
    device.once('error', reject);
  });
  device.subscribe([`wol/${cfg.i}/cmd`], { qos: 0 });
  device.on('message', (topic, payload) => {
    if (topic !== `wol/${cfg.i}/cmd`) return;
    let data;
    try {
      data = JSON.parse(payload.toString());
    } catch (error) {
      received.push({ ok: false, error: 'json' });
      return;
    }
    const result = verifyCommand(cfg, data, { now: data.ts, requireTime: false });
    received.push(result);
    device.publish(
      `wol/${cfg.i}/ack`,
      JSON.stringify({
        v: 1,
        id: data.id,
        ok: result.ok,
        mac: data.m,
        err: result.ok ? '' : result.error,
        ts: Math.floor(Date.now() / 1000),
      }),
    );
  });
  device.publish(
    `wol/${cfg.i}/status`,
    JSON.stringify({
      v: 1,
      online: true,
      ts: Math.floor(Date.now() / 1000),
      time: 1,
      rssi: -52,
      fw: 'test',
    }),
    { retain: true, qos: 0 },
  );

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 420, height: 900, deviceScaleFactor: 2 });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });

    await page.evaluateOnNewDocument((stored) => {
      localStorage.setItem('wol.config.v1', JSON.stringify(stored));
      localStorage.removeItem('wol.log.v1');
    }, cfg);

    await page.goto(`http://127.0.0.1:${webPort}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => document.querySelector('#deviceStateText')?.textContent === '在线',
      { timeout: 15000 },
    );

    const enabled = await page.$eval('#wakeBtn', (button) => !button.disabled);
    assert.equal(enabled, true, '设备在线时开机按钮应可用');
    assert.equal(await page.$eval('#deviceName', (node) => node.textContent), '厨房电脑');

    await page.click('#wakeBtn');
    await page.waitForFunction(
      () => document.querySelector('#wakeHint')?.textContent.includes('设备已确认'),
      { timeout: 15000 },
    );
    await page.screenshot({ path: path.join(TMP, 'dashboard.png'), fullPage: true });

    assert.equal(received.length, 1, 'mock 设备应收到一条命令');
    assert.equal(received[0].ok, true, `签名应通过，实际：${JSON.stringify(received[0])}`);
    assert.deepEqual(received[0].mac, 'AA:BB:CC:DD:EE:FF');
    assert.deepEqual(errors, [], `页面不应有脚本错误：${errors.join('; ')}`);
  } finally {
    await browser.close();
    device.end(true);
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => httpServer.close(resolve));
    await new Promise((resolve) => tcp.close(resolve));
    await aedesBroker.close();
  }
});

test('首次配置页：生成设备码并展示配网步骤',
  { skip: CHROME ? false : 'Chrome not found (set WOL_BROWSER)' },
  async () => {
  const httpServer = await staticServer();
  const port = httpServer.address().port;
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 420, height: 900, deviceScaleFactor: 2 });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#setupView:not(.hidden)');
    await page.type('#setupMac', 'aa-bb-cc-dd-ee-ff');
    await page.click('#generateBtn');
    await page.waitForSelector('#setupResult:not(.hidden)');
    const code = await page.$eval('#codeOutput', (node) => node.value);
    assert.match(code, /^WOL1-[A-Za-z0-9_-]+$/);
    await page.screenshot({ path: path.join(TMP, 'setup-code.png'), fullPage: true });
  } finally {
    await browser.close();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test('App 模式：隐藏安装按钮、跳过 Service Worker、展开导入',
  { skip: CHROME ? false : 'Chrome not found (set WOL_BROWSER)' },
  async () => {
    const httpServer = await staticServer();
    const port = httpServer.address().port;
    const browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    });
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      await page.goto(`http://127.0.0.1:${port}/?app=1`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#setupView:not(.hidden)');
      const info = await page.evaluate(async () => ({
        installDisplay: getComputedStyle(document.querySelector('#installBtn')).display,
        appModeClass: document.body.classList.contains('app-mode'),
        importOpen: !!document.querySelector('#importBox')?.open,
        swCount: 'serviceWorker' in navigator
          ? (await navigator.serviceWorker.getRegistrations()).length
          : 0,
      }));
      assert.equal(info.installDisplay, 'none');
      assert.equal(info.appModeClass, true);
      assert.equal(info.importOpen, true);
      assert.equal(info.swCount, 0);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await new Promise((resolve) => httpServer.close(resolve));
    }
  });
