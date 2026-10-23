import {
  DEFAULT_BROKER,
  brokerUrl,
  buildCommand,
  decodeDeviceCode,
  encodeDeviceCode,
  formatClock,
  newClientId,
  newConfig,
  normalizeMac,
  relativeTime,
  topicFor,
  validateConfig,
} from './core.js';

const STORAGE_CONFIG = 'wol.config.v1';
const STORAGE_LOG = 'wol.log.v1';
const VERSION = '1.0.0';
const APP_MODE = new URLSearchParams(location.search).has('app');
const MAX_LOG = 20;
const ACK_TIMEOUT_MS = 7000;
const STATUS_STALE_SECONDS = 180;

const ERROR_TEXT = {
  timeout: '设备没有确认。请确认 ESP8266 在线，或稍后重试。',
  publish: '命令发送失败，请检查网络后重试。',
  sig: '签名校验失败：设备码和 ESP8266 中的不一致。',
  time: '设备时间未同步，或手机与设备时间差超过 10 分钟。',
  mac: '这个 MAC 不在 ESP8266 允许的列表里。',
  busy: '设备刚处理过一条命令，请等几秒再试。',
  replay: '重复命令已被设备忽略。',
  json: '命令格式错误。',
  command: '设备不认识这条命令。',
  nonce: '命令随机数不合法。',
  id: '命令 ID 不合法。',
};

const TARGET_STATE_TEXT = {
  online: '在线',
  stale: '状态过期',
  offline: '离线',
  unknown: '未知',
};

const $ = (id) => document.getElementById(id);

const ui = {};
let cfg = null;
let client = null;
let clientId = '';
let brokerConnected = false;
let connectionState = 'off';
let status = { online: false, ts: 0, rssi: null, fw: '', timeSynced: false, ip: '' };
let statusReceived = false;
let statusTimer = null;
let selectedMac = '';
let waking = false;
let pending = new Map();
let hintUntil = 0;
let lastErrorAt = 0;
let lastErrorText = '';
let logs = [];
let installPrompt = null;
let tickCount = 0;

function cacheUi() {
  const ids = [
    'brandSub', 'connPill', 'connPillText', 'installBtn',
    'setupView', 'setupForm', 'setupName', 'setupMac', 'setupError',
    'setupBrokerHost', 'setupMqttPort', 'setupWssPort', 'setupPath', 'setupUser', 'setupPass',
    'testBrokerBtn', 'testBrokerStatus', 'generateBtn', 'setupResult', 'codeOutput',
    'copyCodeBtn', 'downloadCodeBtn', 'gotoDashboardBtn', 'importCode', 'importBtn', 'clearSetupBtn',
    'dashboardView', 'deviceName', 'deviceMeta', 'deviceState', 'deviceStateText', 'targets',
    'wakeBtn', 'wakeLabel', 'wakeHint', 'logList', 'logEmpty', 'clearLogBtn',
    'diagBroker', 'diagTopic', 'diagClient', 'diagFw', 'diagIp', 'diagRssi', 'diagTime', 'diagSeen',
    'reconnectBtn', 'settingsCode', 'settingsCopyBtn', 'settingsDownloadBtn', 'reconfigureBtn',
    'clearConfigBtn', 'httpNote', 'versionText', 'toast', 'importBox',
  ];
  for (const id of ids) ui[id] = $(id);
  ui.app = $('app');
}

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch (error) {
    return null;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (error) {
    return false;
  }
}

function storageRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch (error) {
    /* ignore */
  }
}

function isSecureContext() {
  if (window.isSecureContext) return true;
  const host = location.hostname;
  return ['localhost', '127.0.0.1', '[::1]'].includes(host);
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function mqttLib() {
  return globalThis.mqtt && typeof globalThis.mqtt.connect === 'function' ? globalThis.mqtt : null;
}

function loadStoredConfig() {
  const raw = storageGet(STORAGE_CONFIG);
  if (!raw) return null;
  try {
    return validateConfig(JSON.parse(raw));
  } catch (error) {
    storageRemove(STORAGE_CONFIG);
    return null;
  }
}

function persistConfig(next, { silent = false } = {}) {
  cfg = validateConfig(next);
  storageSet(STORAGE_CONFIG, JSON.stringify(cfg));
  if (!cfg.m.includes(selectedMac)) selectedMac = cfg.m[0];
  if (ui.settingsCode) ui.settingsCode.value = encodeDeviceCode(cfg);
  if (!silent) renderDashboard();
}

function currentBrokerUrl() {
  return cfg ? brokerUrl(cfg) : '';
}

function readBrokerFields() {
  const host = ui.setupBrokerHost.value.trim() || DEFAULT_BROKER.b;
  const mqttPort = Number(ui.setupMqttPort.value || DEFAULT_BROKER.p);
  const wssPort = Number(ui.setupWssPort.value || DEFAULT_BROKER.w);
  const path = ui.setupPath.value.trim() || DEFAULT_BROKER.path;
  const user = ui.setupUser.value.trim();
  const password = ui.setupPass.value;
  return {
    b: host,
    p: mqttPort,
    w: wssPort,
    path,
    secure: true,
    u: user,
    pw: password,
  };
}

function fillBrokerFields(broker = DEFAULT_BROKER) {
  ui.setupBrokerHost.value = broker.b || DEFAULT_BROKER.b;
  ui.setupMqttPort.value = String(broker.p || DEFAULT_BROKER.p);
  ui.setupWssPort.value = String(broker.w || DEFAULT_BROKER.w);
  ui.setupPath.value = broker.path || DEFAULT_BROKER.path;
  ui.setupUser.value = broker.u || '';
  ui.setupPass.value = broker.pw || '';
}

function fillSetupFromConfig() {
  if (!cfg) {
    ui.setupName.value = '我的电脑';
    ui.setupMac.value = '';
    fillBrokerFields(DEFAULT_BROKER);
    return;
  }
  ui.setupName.value = cfg.n || '我的电脑';
  ui.setupMac.value = cfg.m.join(', ');
  fillBrokerFields(cfg);
}

function showError(text) {
  if (!text) {
    ui.setupError.classList.add('hidden');
    ui.setupError.textContent = '';
    return;
  }
  ui.setupError.textContent = text;
  ui.setupError.classList.remove('hidden');
}

function setView(view) {
  ui.setupView.classList.toggle('hidden', view !== 'setup');
  ui.dashboardView.classList.toggle('hidden', view !== 'dashboard');
}

function showSetup({ prefill = false } = {}) {
  if (client) disconnectClient();
  setView('setup');
  if (prefill) fillSetupFromConfig();
  ui.setupResult.classList.add('hidden');
  showError('');
  if (prefill && cfg) toast('重新生成会替换本机现有配置，ESP8266 需要重新配网。', 'warn', 4200);
}

function showDashboard() {
  if (!cfg) {
    showSetup();
    return;
  }
  setView('dashboard');
  ui.settingsCode.value = encodeDeviceCode(cfg);
  renderDashboard();
  connect();
}

function parseMacInput(value) {
  const parts = String(value || '')
    .split(/[\s,;，；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (!parts.length) throw new Error('请填写电脑的 MAC 地址');
  const macs = [];
  for (const part of parts) {
    const mac = normalizeMac(part);
    if (!mac) throw new Error(`MAC 地址不合法：${part}`);
    if (!macs.includes(mac)) macs.push(mac);
  }
  if (macs.length > 3) throw new Error('最多支持 3 个 MAC 地址');
  return macs;
}

function generateDevice(event) {
  event.preventDefault();
  showError('');
  try {
    const macs = parseMacInput(ui.setupMac.value);
    const name = ui.setupName.value.trim() || '我的电脑';
    const broker = readBrokerFields();
    const next = newConfig({ macs, name, broker });
    persistConfig(next, { silent: true });
    ui.codeOutput.value = encodeDeviceCode(cfg);
    ui.setupResult.classList.remove('hidden');
    ui.setupResult.scrollIntoView({ behavior: 'smooth', block: 'start' });
    toast('设备码已生成，请按步骤配网。', 'ok');
  } catch (error) {
    showError(error.message || String(error));
  }
}

function testBroker() {
  const mqttClient = mqttLib();
  if (!mqttClient) {
    setTestStatus('MQTT 库未加载', 'bad');
    return;
  }

  let broker;
  try {
    broker = readBrokerFields();
    const probe = validateConfig({
      v: 1,
      b: broker.b,
      p: broker.p,
      w: broker.w,
      path: broker.path,
      i: '0123456789abcdef0123456789abcdef',
      s: 'a'.repeat(64),
      m: ['AA:BB:CC:DD:EE:FF'],
      n: 'probe',
      u: broker.u,
      pw: broker.pw,
      secure: true,
    });
    broker = { ...broker, ...probe };
  } catch (error) {
    setTestStatus(error.message, 'bad');
    return;
  }

  setTestStatus('连接中…', '');
  ui.testBrokerBtn.disabled = true;
  const url = brokerUrl(broker);
  let finished = false;
  let temp = null;

  const finish = (ok, text) => {
    if (finished) return;
    finished = true;
    ui.testBrokerBtn.disabled = false;
    setTestStatus(text, ok ? 'ok' : 'bad');
    if (temp) {
      try { temp.end(true); } catch (error) { /* ignore */ }
    }
  };

  const timer = setTimeout(() => finish(false, '连接超时，检查网络/地址/端口'), 9000);

  try {
    temp = mqttClient.connect(url, {
      clientId: newClientId(),
      clean: true,
      reconnectPeriod: 0,
      connectTimeout: 8000,
      keepalive: 20,
      protocolVersion: 4,
      ...(broker.u ? { username: broker.u, password: broker.pw } : {}),
    });
  } catch (error) {
    clearTimeout(timer);
    finish(false, error.message || '地址格式错误');
    return;
  }

  temp.on('connect', () => {
    clearTimeout(timer);
    temp.subscribe(`wol-probe/${Date.now()}`, { qos: 0 }, () => finish(true, '连接成功'));
  });
  temp.on('error', (error) => {
    clearTimeout(timer);
    finish(false, error && error.message ? error.message : '连接失败');
  });
  temp.on('close', () => {
    if (!finished) {
      clearTimeout(timer);
      finish(false, '连接被关闭');
    }
  });
}

function setTestStatus(text, kind) {
  ui.testBrokerStatus.textContent = text || '';
  ui.testBrokerStatus.classList.remove('ok', 'bad');
  if (kind) ui.testBrokerStatus.classList.add(kind);
}

async function copyText(value) {
  const text = String(value == null ? '' : value);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (error) {
    /* fall through */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', 'readonly');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, area.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch (error) {
    return false;
  }
}

function downloadText(filename, text) {
  try {
    const blob = new Blob([String(text)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    return true;
  } catch (error) {
    return false;
  }
}

function backupText() {
  if (!cfg) return '';
  return [
    '远程开机设备码（请妥善保存）',
    '',
    encodeDeviceCode(cfg),
    '',
    `设备名称：${cfg.n}`,
    `MAC：${cfg.m.join(', ')}`,
    `Broker：${brokerUrl(cfg)}`,
    '',
    '把 WOL1- 开头的整行粘贴到 ESP8266 配网页面即可恢复。',
  ].join('\n');
}

async function copyDeviceCode() {
  if (!cfg) return;
  const ok = await copyText(encodeDeviceCode(cfg));
  toast(ok ? '设备码已复制' : '复制失败，请长按文本框手动复制', ok ? 'ok' : 'bad');
}

function downloadDeviceCode() {
  if (!cfg) return;
  const ok = downloadText('wol-device-code.txt', backupText());
  toast(ok ? '已下载设备码备份' : '下载失败，请手动复制', ok ? 'ok' : 'bad');
}

function importDeviceCode() {
  const raw = ui.importCode.value.trim();
  if (!raw) {
    toast('请先粘贴设备码', 'warn');
    return;
  }
  try {
    const next = decodeDeviceCode(raw);
    persistConfig(next);
    ui.importCode.value = '';
    toast('设备码已导入', 'ok');
    showDashboard();
  } catch (error) {
    toast(error.message || '设备码无效', 'bad', 4500);
  }
}

function connect() {
  const mqttClient = mqttLib();
  if (!cfg) return;
  if (!mqttClient) {
    setConnectionState('off');
    setHint('MQTT 库加载失败，请刷新页面或检查网络。', 'bad', 8000);
    return;
  }

  disconnectClient();
  clientId = newClientId();
  statusReceived = false;
  status = { online: false, ts: 0, rssi: null, fw: '', timeSynced: false };
  renderDashboard();
  setConnectionState('connecting');

  const url = brokerUrl(cfg);
  try {
    client = mqttClient.connect(url, {
      clientId,
      clean: true,
      reconnectPeriod: 4000,
      connectTimeout: 12000,
      keepalive: 30,
      protocolVersion: 4,
      ...(cfg.u ? { username: cfg.u, password: cfg.pw } : {}),
    });
  } catch (error) {
    setConnectionState('off');
    setHint(`Broker 地址可能有误：${error.message || error}`, 'bad', 8000);
    return;
  }

  client.on('connect', () => {
    brokerConnected = true;
    setConnectionState('on');
    const statusTopic = topicFor(cfg, 'status');
    const ackTopic = topicFor(cfg, 'ack');
    client.subscribe([statusTopic, ackTopic], { qos: 0 }, (error) => {
      if (error) addLog('bad', `订阅失败：${error.message || error}`);
    });
    addLog('info', '已连接 MQTT Broker');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      if (!statusReceived && brokerConnected) {
        setHint('Broker 已连接，但设备还没有上报状态。检查 ESP8266 是否配网/在线。', 'warn', 9000);
      }
    }, 6000);
    renderDashboard();
  });

  client.on('reconnect', () => {
    setConnectionState('connecting');
  });

  client.on('offline', () => {
    brokerConnected = false;
    setConnectionState('off');
    renderDashboard();
  });

  client.on('close', () => {
    if (brokerConnected) {
      brokerConnected = false;
      setConnectionState('off');
      renderDashboard();
    }
  });

  client.on('error', (error) => {
    const message = error && error.message ? error.message : String(error);
    const now = Date.now();
    if (message !== lastErrorText || now - lastErrorAt > 10000) {
      lastErrorText = message;
      lastErrorAt = now;
      addLog('warn', `MQTT 错误：${message}`);
    }
  });

  client.on('message', (topic, payload) => {
    handleMessage(topic, payload);
  });
}

function disconnectClient() {
  clearTimeout(statusTimer);
  statusTimer = null;
  if (client) {
    const old = client;
    client = null;
    try {
      old.removeAllListeners();
      old.end(true);
    } catch (error) {
      /* ignore */
    }
  }
  brokerConnected = false;
  pending.forEach((entry) => {
    clearTimeout(entry.timer);
    entry.resolve({ ok: false, error: 'publish' });
  });
  pending = new Map();
}

function setConnectionState(state) {
  connectionState = state;
  const pill = ui.connPill;
  pill.classList.remove('on', 'warn', 'off');
  if (state === 'on') {
    pill.classList.add('on');
    ui.connPillText.textContent = '已连接';
  } else if (state === 'connecting') {
    pill.classList.add('warn');
    ui.connPillText.textContent = '连接中';
  } else {
    pill.classList.add('off');
    ui.connPillText.textContent = '未连接';
  }
  renderWakeAvailability();
  renderHint();
}

function handleMessage(topic, payload) {
  let data;
  try {
    const text = typeof payload === 'string' ? payload : new TextDecoder().decode(payload);
    data = JSON.parse(text);
  } catch (error) {
    return;
  }
  if (!data || typeof data !== 'object') return;

  if (topic === topicFor(cfg, 'status')) {
    handleStatus(data);
    return;
  }
  if (topic === topicFor(cfg, 'ack')) {
    handleAck(data);
  }
}

function handleStatus(data) {
  const previous = status.online;
  const online = data.online === true || data.online === 1;
  status.online = online;
  status.ts = Number(data.ts) || Math.floor(Date.now() / 1000);
  status.rssi = Number.isFinite(Number(data.rssi)) ? Number(data.rssi) : status.rssi;
  status.fw = typeof data.fw === 'string' ? data.fw.slice(0, 16) : status.fw;
  status.ip = typeof data.ip === 'string' ? data.ip.slice(0, 15) : status.ip;
  status.timeSynced = data.time === true || data.time === 1;
  statusReceived = true;
  clearTimeout(statusTimer);

  if (online && !previous) addLog('ok', '设备上线');
  if (!online && previous) addLog('warn', '设备离线');
  renderDashboard();
}

function handleAck(data) {
  const id = String(data.id || '');
  const entry = pending.get(id);
  if (entry) {
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.resolve(data);
  } else if (data.ok === false) {
    addLog('bad', `设备返回错误：${describeError(data.err)}`);
  }
}

function describeError(code) {
  return ERROR_TEXT[String(code || '')] || String(code || '未知错误');
}

function sendCommand(command) {
  return new Promise((resolve) => {
    if (!client || !client.connected) {
      resolve({ ok: false, error: 'publish' });
      return;
    }
    const timer = setTimeout(() => {
      pending.delete(command.id);
      resolve({ ok: false, error: 'timeout' });
    }, ACK_TIMEOUT_MS);

    pending.set(command.id, { resolve, timer });

    try {
      client.publish(topicFor(cfg, 'cmd'), JSON.stringify(command), { qos: 0 }, (error) => {
        if (error) {
          clearTimeout(timer);
          pending.delete(command.id);
          resolve({ ok: false, error: 'publish' });
        }
      });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(command.id);
      resolve({ ok: false, error: 'publish' });
    }
  });
}

async function wake() {
  if (waking || !cfg) return;
  if (!brokerConnected || !client || !client.connected) {
    toast('Broker 未连接，请稍后再试', 'bad');
    return;
  }

  const mac = selectedMac || cfg.m[0];
  let command;
  try {
    command = buildCommand(cfg, mac);
  } catch (error) {
    toast(error.message || '命令生成失败', 'bad');
    return;
  }

  waking = true;
  renderWakeAvailability();
  ui.wakeBtn.classList.add('busy');
  ui.wakeLabel.textContent = '发送中';
  setHint('正在发送唤醒包…', '', ACK_TIMEOUT_MS);

  const result = await sendCommand(command);
  waking = false;
  ui.wakeBtn.classList.remove('busy');
  ui.wakeLabel.textContent = '开机';
  renderWakeAvailability();

  if (result && result.ok) {
    setHint('唤醒包已发送，设备已确认。', 'ok', 8000);
    addLog('ok', `已唤醒 ${command.m}`);
    toast('已发送唤醒包', 'ok');
  } else {
    const code = result && result.error ? result.error : 'timeout';
    setHint(describeError(code), 'bad', 9000);
    addLog('bad', describeError(code));
  }
  renderDiag();
}

function renderWakeAvailability() {
  const available = !!cfg && brokerConnected && !waking;
  if (ui.wakeBtn) ui.wakeBtn.disabled = !available;
  if (ui.wakeLabel && !waking) ui.wakeLabel.textContent = '开机';
}

function targetState() {
  if (!statusReceived) return 'unknown';
  if (!status.online) return 'offline';
  const age = Math.floor(Date.now() / 1000) - status.ts;
  if (age > STATUS_STALE_SECONDS) return 'stale';
  return 'online';
}

function renderStatus() {
  if (!cfg) return;
  const state = targetState();
  ui.deviceState.classList.remove('on', 'warn', 'off');
  if (state === 'online') ui.deviceState.classList.add('on');
  else if (state === 'stale') ui.deviceState.classList.add('warn');
  else ui.deviceState.classList.add('off');
  ui.deviceStateText.textContent = TARGET_STATE_TEXT[state] || '未知';

  if (state === 'online') {
    const rssi = Number.isFinite(status.rssi) ? ` · 信号 ${status.rssi} dBm` : '';
    ui.deviceMeta.textContent = `最后上报 ${relativeTime(status.ts)}${rssi}`;
  } else if (state === 'stale') {
    ui.deviceMeta.textContent = `最后上报 ${relativeTime(status.ts)}，状态可能已过期`;
  } else if (state === 'offline') {
    ui.deviceMeta.textContent = `离线 · 最后上线 ${relativeTime(status.ts)}`;
  } else {
    ui.deviceMeta.textContent = brokerConnected ? '已连接 Broker，等待设备状态…' : '等待连接 Broker…';
  }

  if (state === 'online') {
    ui.deviceStateText.textContent = '在线';
  } else if (state === 'stale') {
    ui.deviceStateText.textContent = '状态过期';
  } else if (state === 'offline') {
    ui.deviceStateText.textContent = '离线';
  } else {
    ui.deviceStateText.textContent = '未知';
  }
  renderHint();
}

function renderHint() {
  if (!ui.wakeHint) return;
  if (Date.now() < hintUntil) return;
  if (!brokerConnected) {
    ui.wakeHint.textContent = 'Broker 未连接，正在重连…';
    ui.wakeHint.className = 'hint';
    return;
  }
  const state = targetState();
  if (state === 'online') {
    ui.wakeHint.textContent = '设备在线，点击按钮发送唤醒包。';
    ui.wakeHint.className = 'hint';
  } else if (state === 'offline' || state === 'stale') {
    ui.wakeHint.textContent = '设备当前离线，命令可能无法送达。';
    ui.wakeHint.className = 'hint';
  } else {
    ui.wakeHint.textContent = '已连接 Broker，等待设备上报状态…';
    ui.wakeHint.className = 'hint';
  }
}

function setHint(text, kind, durationMs) {
  ui.wakeHint.textContent = text;
  ui.wakeHint.className = `hint${kind ? ` ${kind}` : ''}`;
  hintUntil = Date.now() + (durationMs || 0);
}

function renderTargets() {
  if (!cfg) return;
  const container = ui.targets;
  container.textContent = '';
  if (cfg.m.length <= 1) {
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');
  cfg.m.forEach((mac) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'target-chip';
    button.textContent = mac;
    button.setAttribute('aria-pressed', mac === selectedMac ? 'true' : 'false');
    button.addEventListener('click', () => {
      selectedMac = mac;
      renderTargets();
    });
    container.appendChild(button);
  });
}

function renderDashboard() {
  if (!cfg) return;
  ui.deviceName.textContent = cfg.n || '我的电脑';
  ui.settingsCode.value = encodeDeviceCode(cfg);
  renderTargets();
  renderStatus();
  renderWakeAvailability();
  renderDiag();
}

function renderDiag() {
  if (!cfg) return;
  ui.diagBroker.textContent = brokerUrl(cfg);
  ui.diagTopic.textContent = `wol/${cfg.i}`;
  ui.diagClient.textContent = clientId || '—';
  ui.diagFw.textContent = status.fw || '—';
  if (ui.diagIp) ui.diagIp.textContent = status.ip || '—';
  ui.diagRssi.textContent = Number.isFinite(status.rssi) ? `${status.rssi} dBm` : '—';
  ui.diagTime.textContent = status.timeSynced ? '已同步' : statusReceived ? '未同步' : '—';
  ui.diagSeen.textContent = status.ts
    ? `${formatClock(status.ts)}（${relativeTime(status.ts)}）`
    : '—';
}

function addLog(kind, text) {
  const entry = {
    t: Math.floor(Date.now() / 1000),
    kind: ['ok', 'bad', 'warn', 'info'].includes(kind) ? kind : 'info',
    text: String(text),
  };
  logs.unshift(entry);
  logs = logs.slice(0, MAX_LOG);
  persistLogs();
  renderLogs();
}

function persistLogs() {
  storageSet(STORAGE_LOG, JSON.stringify(logs));
}

function loadLogs() {
  const raw = storageGet(STORAGE_LOG);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      logs = parsed
        .filter((item) => item && typeof item.text === 'string')
        .slice(0, MAX_LOG)
        .map((item) => ({
          t: Number(item.t) || Math.floor(Date.now() / 1000),
          kind: ['ok', 'bad', 'warn', 'info'].includes(item.kind) ? item.kind : 'info',
          text: item.text,
        }));
    }
  } catch (error) {
    logs = [];
  }
}

function renderLogs() {
  if (!ui.logList) return;
  ui.logList.textContent = '';
  ui.logEmpty.classList.toggle('hidden', logs.length > 0);
  for (const entry of logs) {
    const li = document.createElement('li');
    li.className = `log-item ${entry.kind}`;
    const dot = document.createElement('span');
    dot.className = 'log-dot';
    const text = document.createElement('span');
    text.className = 'log-text';
    text.textContent = entry.text;
    const time = document.createElement('time');
    time.className = 'log-time';
    time.textContent = new Date(entry.t * 1000).toLocaleTimeString('zh-CN', { hour12: false });
    li.append(dot, text, time);
    ui.logList.appendChild(li);
  }
}

function clearLogs() {
  logs = [];
  storageRemove(STORAGE_LOG);
  renderLogs();
  toast('事件记录已清空', 'ok');
}

function clearConfig() {
  if (!window.confirm('确定清除本机保存的设备码吗？ESP8266 中的配置不会被修改。')) return;
  disconnectClient();
  cfg = null;
  selectedMac = '';
  storageRemove(STORAGE_CONFIG);
  status = { online: false, ts: 0, rssi: null, fw: '', timeSynced: false, ip: '' };
  statusReceived = false;
  statusTimer = null;
  setConnectionState('off');
  showSetup();
  toast('本机配置已清除', 'ok');
}

function toast(text, kind = '', duration = 3000) {
  if (!ui.toast) return;
  ui.toast.textContent = text;
  ui.toast.className = `toast show${kind ? ` ${kind}` : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    ui.toast.className = 'toast';
  }, duration);
}

function tick() {
  tickCount += 1;
  if (!cfg || ui.dashboardView.classList.contains('hidden')) return;
  if (Date.now() >= hintUntil) {
    hintUntil = 0;
    renderHint();
  }
  renderStatus();
  if (tickCount % 5 === 0) renderDiag();
}

function registerServiceWorker() {
  if (APP_MODE) return;
  if (!isSecureContext()) {
    ui.httpNote.classList.remove('hidden');
    return;
  }
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker
    .register('./sw.js', { scope: './', updateViaCache: 'none' })
    .then((registration) => {
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            toast('新版本已就绪，刷新页面后生效。', 'ok', 5000);
          }
        });
      });
    })
    .catch((error) => {
      addLog('warn', `离线缓存未启用：${error.message || error}`);
    });
}

function setupInstallPrompt() {
  if (APP_MODE) {
    ui.installBtn.classList.add('hidden');
    return;
  }
  if (isStandalone()) {
    ui.installBtn.classList.add('hidden');
    return;
  }
  // 安卓上直接显示按钮：浏览器没触发 beforeinstallprompt 时，
  // 点击按钮给出“菜单 → 添加到主屏幕”的提示。
  if (/Android/i.test(navigator.userAgent)) {
    ui.installBtn.classList.remove('hidden');
  }
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    ui.installBtn.classList.remove('hidden');
  });
  ui.installBtn.addEventListener('click', async () => {
    if (!installPrompt) {
      toast('在浏览器菜单中选择“添加到主屏幕”即可。', '', 4200);
      return;
    }
    installPrompt.prompt();
    try {
      await installPrompt.userChoice;
    } catch (error) {
      /* ignore */
    }
    installPrompt = null;
    ui.installBtn.classList.add('hidden');
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    ui.installBtn.classList.add('hidden');
    toast('已添加到桌面', 'ok');
  });
}

function bindEvents() {
  ui.setupForm.addEventListener('submit', generateDevice);
  ui.testBrokerBtn.addEventListener('click', testBroker);
  ui.copyCodeBtn.addEventListener('click', copyDeviceCode);
  ui.downloadCodeBtn.addEventListener('click', downloadDeviceCode);
  ui.gotoDashboardBtn.addEventListener('click', () => {
    if (!cfg) {
      showError('请先生成设备码');
      return;
    }
    showDashboard();
  });
  ui.importBtn.addEventListener('click', importDeviceCode);
  ui.clearSetupBtn.addEventListener('click', clearConfig);
  ui.wakeBtn.addEventListener('click', wake);
  ui.clearLogBtn.addEventListener('click', clearLogs);
  ui.reconnectBtn.addEventListener('click', () => {
    addLog('info', '手动重连 Broker');
    connect();
  });
  ui.settingsCopyBtn.addEventListener('click', copyDeviceCode);
  ui.settingsDownloadBtn.addEventListener('click', downloadDeviceCode);
  ui.reconfigureBtn.addEventListener('click', () => {
    if (!cfg) return;
    const ok = window.confirm('重新配置会生成新的设备码，ESP8266 需要重新配网。继续？');
    if (ok) showSetup({ prefill: true });
  });
  ui.clearConfigBtn.addEventListener('click', clearConfig);

  window.addEventListener('online', () => {
    addLog('info', '手机网络已恢复');
    if (cfg && !brokerConnected) connect();
  });
  window.addEventListener('offline', () => {
    addLog('warn', '手机网络已断开');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && cfg && client && !client.connected) {
      connect();
    }
  });
}

function init() {
  cacheUi();
  if (APP_MODE) {
    document.body.classList.add('app-mode');
    ui.installBtn.classList.add('hidden');
    ui.httpNote.classList.add('hidden');
  }
  ui.versionText.textContent = `v${VERSION}`;
  ui.brandSub.textContent = `ESP8266 · Wake-on-LAN · v${VERSION}`;

  fillBrokerFields(DEFAULT_BROKER);
  loadLogs();
  renderLogs();
  bindEvents();
  setupInstallPrompt();
  registerServiceWorker();
  setConnectionState('off');

  cfg = loadStoredConfig();
  if (cfg) {
    selectedMac = cfg.m[0];
    showDashboard();
  } else {
    showSetup();
    if (APP_MODE && ui.importBox) ui.importBox.open = true;
  }

  setInterval(tick, 1000);
  if (!APP_MODE && window.isSecureContext === false) ui.httpNote.classList.remove('hidden');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
