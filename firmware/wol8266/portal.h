#pragma once

#include <Arduino.h>
#include <ESP8266WebServer.h>
#include <DNSServer.h>
#include <ESP8266WiFi.h>
#include "app_config.h"
#include "config_store.h"
#include "device_code.h"

ESP8266WebServer g_portalServer(80);
DNSServer g_portalDns;
unsigned long g_portalStartMs = 0;
String g_portalNotice;

static String htmlEscape(const String& value) {
  String out;
  out.reserve(value.length() + 8);
  for (size_t i = 0; i < value.length(); i++) {
    char c = value[i];
    switch (c) {
      case '&': out += F("&amp;"); break;
      case '<': out += F("&lt;"); break;
      case '>': out += F("&gt;"); break;
      case '"': out += F("&quot;"); break;
      case '\'': out += F("&#39;"); break;
      default: out += c; break;
    }
  }
  return out;
}

static const char PORTAL_HTML[] PROGMEM = R"HTML(<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#070b14">
<title>ESP8266 配网 · 远程开机</title>
<style>
:root{--bg:#070b14;--card:#111a2c;--line:rgba(148,163,184,.2);--text:#e8eef8;--muted:#93a4bd;--cyan:#22d3ee;--green:#34d399}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(800px 400px at 20% 0%,rgba(34,211,238,.18),transparent 60%),var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;padding:24px 16px calc(24px + env(safe-area-inset-bottom))}
.wrap{max-width:520px;margin:0 auto}
.badge{display:inline-flex;gap:8px;align-items:center;font-size:11px;letter-spacing:.14em;color:var(--cyan);text-transform:uppercase;margin-bottom:10px}
.badge:before{content:"";width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 0 4px rgba(52,211,153,.12)}
.card{background:rgba(17,26,44,.86);border:1px solid var(--line);border-radius:20px;padding:22px;box-shadow:0 20px 60px rgba(2,6,23,.5)}
h1{margin:0 0 8px;font-size:23px;line-height:1.25}.lead{margin:0 0 18px;color:var(--muted);font-size:13px;line-height:1.75}
.notice{margin:0 0 14px;padding:11px 12px;border:1px solid rgba(251,191,36,.3);background:rgba(251,191,36,.08);color:#fde68a;border-radius:10px;font-size:12px;line-height:1.6}
label{display:block;margin-bottom:14px;font-size:12.5px;color:#cbd5e1;font-weight:600}
input,textarea{display:block;width:100%;margin-top:7px;background:rgba(2,6,23,.6);border:1px solid var(--line);border-radius:12px;padding:12px;color:var(--text);font:inherit;font-size:14px;outline:none}
input:focus,textarea:focus{border-color:rgba(34,211,238,.6);box-shadow:0 0 0 3px rgba(34,211,238,.12)}
textarea{resize:vertical;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;line-height:1.55;word-break:break-all;color:#a5f3fc}
button{width:100%;border:0;border-radius:12px;padding:13px;background:linear-gradient(135deg,#67e8f9,#34d399);color:#031318;font:inherit;font-size:14px;font-weight:700;margin-top:4px}
button:active{transform:translateY(1px)}
button.danger{background:transparent;border:1px solid rgba(251,113,133,.35);color:#fecdd3;font-weight:600;font-size:12px;padding:10px;margin-top:12px}
.hint{margin:10px 0 0;color:#64748b;font-size:11.5px;line-height:1.65}
.meta{display:flex;justify-content:space-between;gap:10px;margin-top:18px;padding-top:14px;border-top:1px solid var(--line);color:#64748b;font-size:11px;word-break:break-all}
a{color:var(--cyan)}
</style></head><body><div class="wrap"><div class="badge">ESP8266 · WiFi 配网</div>
<div class="card">
<h1>连接家里的 WiFi</h1>
<p class="lead">先在上一步网页里复制设备码，然后填写家里的 WiFi。保存后设备会自动重启。</p>
%REASON%
<form method="post" action="/save" autocomplete="off">
<label>WiFi 名称<input name="ssid" value="%SSID%" maxlength="32" placeholder="家里的 WiFi 名称" required></label>
<label>WiFi 密码<input name="pass" type="password" maxlength="64" placeholder="留空表示开放网络"></label>
<label>设备码<textarea name="code" rows="5" maxlength="700" placeholder="WOL1-..." required></textarea></label>
<button type="submit">保存并重启</button>
</form>
<form method="post" action="/clear" onsubmit="return confirm('确定清除设备配置并重启吗？');">
<button class="danger" type="submit">清除配置并重启</button>
</form>
<p class="hint">设备码在手机网页“创建你的开机设备”里生成。热点只用于配网，10 分钟后会自动重启；如果保存失败，重新连接热点再试。</p>
<div class="meta"><span>Broker: %BROKER%</span><span>v%VERSION%</span></div>
</div></div></body></html>)HTML";

static String portalPage() {
  String page = FPSTR(PORTAL_HTML);
  String ssid = configValid(g_cfg) ? String(g_cfg.wifiSsid) : String("");
  page.replace("%SSID%", htmlEscape(ssid));
  page.replace("%BROKER%", htmlEscape(configValid(g_cfg) ? String(g_cfg.broker) : String("未配置")));
  page.replace("%VERSION%", WOL_FW_VERSION);
  String notice = g_portalNotice.length()
                      ? String("<div class=\"notice\">") + htmlEscape(g_portalNotice) + "</div>"
                      : String("");
  page.replace("%REASON%", notice);
  return page;
}

static void sendPortalPage() {
  g_portalServer.send(200, "text/html; charset=utf-8", portalPage());
}

static void sendPortalMessage(const String& title, const String& message, bool success) {
  String html = F("<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
                  "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
                  "<title>");
  html += htmlEscape(title);
  html += F("</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;"
            "background:#070b14;color:#e8eef8;font-family:-apple-system,\"Segoe UI\",\"Microsoft YaHei\",sans-serif;"
            "padding:24px}.card{max-width:420px;background:#111a2c;border:1px solid rgba(148,163,184,.2);"
            "border-radius:20px;padding:26px;text-align:center}h1{font-size:21px;margin:0 0 10px;"
            "color:");
  html += success ? F("#34d399") : F("#fb7185");
  html += F("}p{color:#93a4bd;font-size:13px;line-height:1.8;margin:0 0 18px}"
            "a{color:#22d3ee;font-size:13px}</style></head><body><div class=\"card\"><h1>");
  html += htmlEscape(title);
  html += F("</h1><p>");
  html += htmlEscape(message);
  html += F("</p><a href=\"/\">返回配网页面</a></div></body></html>");
  g_portalServer.send(success ? 200 : 400, "text/html; charset=utf-8", html);
}

static void handlePortalSave() {
  String ssid = g_portalServer.arg("ssid");
  String pass = g_portalServer.arg("pass");
  String code = g_portalServer.arg("code");
  ssid.trim();
  code.trim();

  if (ssid.length() == 0 || ssid.length() > 32) {
    sendPortalMessage("WiFi 名称无效", "WiFi 名称必须是 1–32 个字符。", false);
    return;
  }
  if (pass.length() > 64) {
    sendPortalMessage("WiFi 密码过长", "密码最多 64 个字符。", false);
    return;
  }
  if (code.length() < 20 || code.length() > 700) {
    sendPortalMessage("设备码无效", "请回到网页复制完整设备码再粘贴。", false);
    return;
  }

  Serial.printf("[portal] save: heap=%u stack=%u codeLen=%u\n",
                ESP.getFreeHeap(), ESP.getFreeContStack(), (unsigned int)code.length());

  static Config next;
  if (!parseDeviceCode(code.c_str(), next)) {
    sendPortalMessage("设备码解析失败", "设备码可能少复制了一段，或不是最新版本。请在网页重新复制。", false);
    return;
  }
  Serial.printf("[portal] parsed macs=%u heap=%u stack=%u\n",
                next.macCount, ESP.getFreeHeap(), ESP.getFreeContStack());

  copyStr(next.wifiSsid, sizeof(next.wifiSsid), ssid.c_str());
  copyStr(next.wifiPass, sizeof(next.wifiPass), pass.c_str());
  g_cfg = next;

  if (!saveConfig()) {
    sendPortalMessage("保存失败", "写入 Flash 失败，请重试。", false);
    return;
  }

  Serial.printf("[portal] saved config, broker=%s topic=%s\n", g_cfg.broker, g_cfg.topicId);
  sendPortalMessage("保存成功", "设备正在重启并连接 WiFi。请把手机切回家里 WiFi，然后回到控制台。", true);
  delay(1200);
  ESP.restart();
}

static void handlePortalClear() {
  clearConfig();
  Serial.println("[portal] config cleared");
  sendPortalMessage("配置已清除", "设备正在重启，稍后重新连接 WOL-xxxx 进行配网。", true);
  delay(1200);
  ESP.restart();
}

static void startPortal(const char* reason) {
  WiFi.persistent(false);
  WiFi.disconnect(true);
  WiFi.mode(WIFI_AP);

  String apName = String(WOL_AP_PREFIX) + String(ESP.getChipId() & 0xFFFF, HEX);
  apName.toUpperCase();
  bool ok = WiFi.softAP(apName.c_str());
  delay(250);

  g_portalNotice = reason ? String(reason) : String("");
  g_portalDns.start(53, "*", WiFi.softAPIP());
  g_portalServer.on("/", HTTP_GET, sendPortalPage);
  g_portalServer.on("/save", HTTP_POST, handlePortalSave);
  g_portalServer.on("/clear", HTTP_POST, handlePortalClear);
  g_portalServer.on("/favicon.ico", HTTP_GET, []() { g_portalServer.send(204); });
  g_portalServer.onNotFound(sendPortalPage);
  g_portalServer.begin();
  g_portalStartMs = millis();

  Serial.printf("[portal] AP %s %s, IP %s\n", apName.c_str(), ok ? "started" : "FAILED",
                WiFi.softAPIP().toString().c_str());
  Serial.println("[portal] 手机连接该热点后打开 http://192.168.4.1");
}

static void portalLoop() {
  g_portalDns.processNextRequest();
  g_portalServer.handleClient();
  if (millis() - g_portalStartMs > WOL_PORTAL_TIMEOUT_MS) {
    Serial.println("[portal] timeout, restarting");
    ESP.restart();
  }
}
