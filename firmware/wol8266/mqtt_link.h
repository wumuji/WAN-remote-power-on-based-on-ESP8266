#pragma once

#include <Arduino.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ESP8266WiFi.h>
#include "app_config.h"
#include "config_store.h"
#include "protocol.h"
#include "wol.h"
#include "time_sync.h"

extern WiFiClientSecure g_tls;
extern PubSubClient g_mqtt;

static char g_cmdTopic[80];
static char g_ackTopic[80];
static char g_statusTopic[80];
static char g_mqttClientId[32];

static unsigned long g_nextMqttAttempt = 0;
static unsigned long g_mqttBackoff = 2000;
static unsigned long g_lastStatusAt = 0;
static unsigned long g_lastWakeMs = 0;
static bool g_hasWoken = false;

static const char MQTT_LWT[] = "{\"v\":1,\"online\":false}";

static void buildTopics() {
  snprintf(g_cmdTopic, sizeof(g_cmdTopic), "wol/%s/cmd", g_cfg.topicId);
  snprintf(g_ackTopic, sizeof(g_ackTopic), "wol/%s/ack", g_cfg.topicId);
  snprintf(g_statusTopic, sizeof(g_statusTopic), "wol/%s/status", g_cfg.topicId);
  snprintf(g_mqttClientId, sizeof(g_mqttClientId), "wol8266-%06x", (unsigned int)(ESP.getChipId() & 0xFFFFFF));
}

static void publishStatus() {
  if (!g_mqtt.connected()) return;
  char payload[224];
  snprintf(payload, sizeof(payload),
           "{\"v\":1,\"online\":true,\"ts\":%lu,\"time\":%d,\"rssi\":%d,\"fw\":\"%s\",\"heap\":%u,\"ip\":\"%s\"}",
           (unsigned long)nowSeconds(), g_timeSynced ? 1 : 0,
           (int)WiFi.RSSI(), WOL_FW_VERSION, (unsigned int)ESP.getFreeHeap(),
           WiFi.localIP().toString().c_str());
  bool ok = g_mqtt.publish(g_statusTopic, payload, true);
  g_lastStatusAt = millis();
  Serial.printf("[mqtt] status %s %s\n", ok ? "sent" : "FAILED", payload);
}

static void publishAck(const char* id, bool ok, const char* mac, const char* error) {
  if (!id || id[0] == '\0') return;
  if (!g_mqtt.connected()) return;
  char payload[192];
  snprintf(payload, sizeof(payload),
           "{\"v\":1,\"id\":\"%s\",\"ok\":%s,\"mac\":\"%s\",\"err\":\"%s\",\"ts\":%lu}",
           id, ok ? "true" : "false", mac ? mac : "", error ? error : "",
           (unsigned long)nowSeconds());
  g_mqtt.publish(g_ackTopic, payload, false);
  Serial.printf("[mqtt] ack %s\n", payload);
}

static void onMqttMessage(char* topic, uint8_t* payload, unsigned int length) {
  if (strcmp(topic, g_cmdTopic) != 0) return;

  CommandResult result;
  if (!verifyCommand(reinterpret_cast<const char*>(payload), length, result)) {
    Serial.printf("[cmd] rejected: %s\n", result.error);
    publishAck(result.id, false, "", result.error);
    return;
  }

  if (g_hasWoken && millis() - g_lastWakeMs < WOL_COOLDOWN_MS) {
    Serial.println("[cmd] rejected: busy");
    publishAck(result.id, false, "", "busy");
    return;
  }

  sendWake(result.mac);
  g_lastWakeMs = millis();
  g_hasWoken = true;
  publishAck(result.id, true, result.mac, "");
}

static bool attemptMqttConnect() {
  Serial.printf("[mqtt] connecting %s:%u as %s\n", g_cfg.broker, g_cfg.mqttPort, g_mqttClientId);
  g_tls.setInsecure();

  bool ok;
  if (g_cfg.user[0] != '\0') {
    ok = g_mqtt.connect(g_mqttClientId, g_cfg.user, g_cfg.pass,
                        g_statusTopic, 0, true, MQTT_LWT);
  } else {
    ok = g_mqtt.connect(g_mqttClientId, nullptr, nullptr,
                        g_statusTopic, 0, true, MQTT_LWT);
  }

  if (!ok) {
    Serial.printf("[mqtt] connect failed, state=%d\n", g_mqtt.state());
    return false;
  }

  Serial.println("[mqtt] connected");
  g_mqtt.subscribe(g_cmdTopic, 1);
  publishStatus();
  g_mqttBackoff = 2000;
  g_nextMqttAttempt = 0;
  return true;
}

static void mqttBegin() {
  buildTopics();
  g_tls.setInsecure();
  g_mqtt.setServer(g_cfg.broker, g_cfg.mqttPort);
  g_mqtt.setCallback(onMqttMessage);
  g_mqtt.setKeepAlive(WOL_MQTT_KEEPALIVE);
  g_mqtt.setSocketTimeout(10);
  g_mqtt.setBufferSize(WOL_MQTT_BUFFER_SIZE);
  g_nextMqttAttempt = 0;
  g_mqttBackoff = 2000;
}

static bool mqttConnected() {
  return g_mqtt.connected();
}

static void mqttLoop() {
  if (WiFi.status() != WL_CONNECTED) {
    static unsigned long lastWifiRetry = 0;
    if (millis() - lastWifiRetry > 5000) {
      lastWifiRetry = millis();
      Serial.println("[wifi] lost, reconnecting");
      WiFi.reconnect();
    }
    return;
  }

  if (!g_mqtt.connected()) {
    if (millis() < g_nextMqttAttempt) return;
    if (attemptMqttConnect()) return;
    g_nextMqttAttempt = millis() + g_mqttBackoff;
    g_mqttBackoff = (g_mqttBackoff < 30000UL) ? (g_mqttBackoff * 2UL) : 60000UL;
    return;
  }

  g_mqtt.loop();

  if (millis() - g_lastStatusAt > WOL_STATUS_INTERVAL_MS) {
    publishStatus();
  }
}
