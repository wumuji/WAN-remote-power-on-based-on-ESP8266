/*
 * ESP8266 远程开机固件
 *
 * 流程：配网热点 -> 保存 WiFi + 设备码 -> 连接 MQTT(TLS) ->
 *       收到带 HMAC 签名的 wake 命令 -> 局域网广播 WOL 魔术包。
 */

#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <WiFiUdp.h>
#include <EEPROM.h>
#include <ArduinoJson.h>
#include <time.h>

#include "app_config.h"
#include "config_store.h"
#include "device_code.h"
#include "hmac_sha256.h"
#include "wol.h"
#include "status_led.h"
#include "time_sync.h"
#include "protocol.h"
#include "portal.h"
#include "mqtt_link.h"

Config g_cfg;
WiFiClientSecure g_tls;
PubSubClient g_mqtt(g_tls);
WiFiUDP g_udp;
bool g_timeSynced = false;

enum RunMode {
  MODE_RUN,
  MODE_PORTAL,
};

static RunMode g_mode = MODE_RUN;

static void enterPortal(const char* reason) {
  if (g_mqtt.connected()) g_mqtt.disconnect();
  g_mode = MODE_PORTAL;
  ledSetMode(LED_PORTAL);
  startPortal(reason);
}

static void connectWiFi() {
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.hostname("wol8266");
  WiFi.begin(g_cfg.wifiSsid, g_cfg.wifiPass);

  ledSetMode(LED_WIFI);
  unsigned long started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < WOL_WIFI_CONNECT_TIMEOUT_MS) {
    delay(100);
    ledLoop();
    ESP.wdtFeed();
  }

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[wifi] connect timeout");
    enterPortal("连接 WiFi 失败，请检查名称和密码。");
    return;
  }

  Serial.printf("[wifi] connected %s rssi=%d\n", WiFi.localIP().toString().c_str(), (int)WiFi.RSSI());
  if (!g_udp.begin(0)) {
    Serial.println("[wol] udp begin failed");
  }
  startTimeSync();
  ledSetMode(LED_MQTT);
  mqttBegin();
}

static void handleButton() {
  static bool pressed = false;
  static unsigned long pressedAt = 0;
  static bool longFired = false;

  bool down = digitalRead(WOL_BUTTON_PIN) == LOW;
  if (down && !pressed) {
    pressed = true;
    pressedAt = millis();
    longFired = false;
  }

  if (down && pressed && !longFired && millis() - pressedAt > 5000UL) {
    longFired = true;
    Serial.println("[button] long press -> portal");
    enterPortal("已进入配网模式。保存新配置，或等待超时后自动重启。");
  }

  if (!down && pressed) {
    pressed = false;
    if (!longFired && millis() - pressedAt > 60UL) {
      Serial.println("[button] short press -> local wake");
      sendWake(g_cfg.macs[0]);
    }
  }
}

void setup() {
  Serial.begin(WOL_SERIAL_BAUD);
  delay(200);
  Serial.printf("\n\nWOL8266 %s chip=%06x\n", WOL_FW_VERSION,
                (unsigned int)(ESP.getChipId() & 0xFFFFFF));

  ledInit();
  pinMode(WOL_BUTTON_PIN, INPUT_PULLUP);
  EEPROM.begin(WOL_EEPROM_SIZE);

  bool valid = loadConfig();
  hmacSelfTest();

  if (!valid) {
    Serial.println("[config] no valid config -> portal");
    enterPortal("设备还没有配置，请填写 WiFi 和设备码。");
    return;
  }

  Serial.printf("[config] broker=%s port=%u topic=%s macs=%u\n",
                g_cfg.broker, g_cfg.mqttPort, g_cfg.topicId, g_cfg.macCount);
  connectWiFi();
}

void loop() {
  if (g_mode == MODE_PORTAL) {
    portalLoop();
    ledLoop();
    delay(2);
    return;
  }

  updateTimeSync();
  mqttLoop();

  if (WiFi.status() != WL_CONNECTED) ledSetMode(LED_WIFI);
  else if (!mqttConnected()) ledSetMode(LED_MQTT);
  else ledSetMode(LED_ONLINE);

  ledLoop();
  handleButton();
  delay(2);
}
