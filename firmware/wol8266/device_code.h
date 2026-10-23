#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include <string.h>
#include <ctype.h>
#include "app_config.h"
#include "config_store.h"

// 解析网页生成的设备码：
// WOL1-<base64url(JSON)>
// JSON 字段：v,b,p,i,s,m,u,pw
// 固件忽略网页专用的 w/path/secure/n 字段。

static inline int base64UrlDecode(const char* input, uint8_t* output, size_t capacity) {
  if (!input || !output) return -1;
  uint32_t acc = 0;
  int bits = 0;
  size_t outLen = 0;
  for (const char* p = input; *p; p++) {
    char c = *p;
    if (c == '=' || c == ' ' || c == '\r' || c == '\n' || c == '\t') continue;
    int value;
    if (c >= 'A' && c <= 'Z') value = c - 'A';
    else if (c >= 'a' && c <= 'z') value = c - 'a' + 26;
    else if (c >= '0' && c <= '9') value = c - '0' + 52;
    else if (c == '-') value = 62;
    else if (c == '_') value = 63;
    else return -1;
    acc = (acc << 6) | (uint32_t)value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (outLen >= capacity) return -1;
      output[outLen++] = (uint8_t)((acc >> bits) & 0xFF);
    }
  }
  return (int)outLen;
}

static inline bool isValidBroker(const char* broker) {
  if (!broker) return false;
  size_t len = strlen(broker);
  if (len == 0 || len > 63) return false;
  if (broker[0] == '.' || broker[len - 1] == '.') return false;
  for (size_t i = 0; i < len; i++) {
    char c = broker[i];
    if (!(isalnum((unsigned char)c) || c == '.' || c == '-')) return false;
  }
  return true;
}

static inline bool parseDeviceCode(const char* rawCode, Config& out) {
  if (!rawCode) return false;

  // 不复制整段设备码到栈上：ESP8266 的 loop 栈只有约 4KB。
  const char* code = rawCode;
  while (*code && isspace((unsigned char)*code)) code++;
  if (strncmp(code, "WOL1-", 5) != 0) return false;
  size_t codeLen = strlen(code);
  if (codeLen < 20 || codeLen > 700) return false;

  static char json[1024];
  int jsonLen = base64UrlDecode(code + 5, reinterpret_cast<uint8_t*>(json), sizeof(json) - 1);
  if (jsonLen <= 0) return false;
  json[jsonLen] = '\0';

  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, json, (size_t)jsonLen);
  if (error) return false;

  if ((int)(doc["v"] | 0) != 1) return false;

  const char* broker = doc["b"] | "";
  const int port = doc["p"] | 0;
  const char* topicId = doc["i"] | "";
  const char* secret = doc["s"] | "";
  const char* user = doc["u"] | "";
  const char* pass = doc["pw"] | "";

  if (!isValidBroker(broker)) return false;
  if (port < 1 || port > 65535) return false;
  if (!isHexString(topicId, 16, 32)) return false;
  if (!isHexString(secret, 64, 64)) return false;
  if (strlen(user) > 32 || strlen(pass) > 32) return false;

  JsonArray macArray = doc["m"].as<JsonArray>();
  if (macArray.isNull() || macArray.size() == 0 || macArray.size() > WOL_MAX_MACS) return false;

  memset(&out, 0, sizeof(out));
  out.magic = WOL_EEPROM_MAGIC;
  out.version = WOL_CONFIG_VERSION;
  copyStr(out.broker, sizeof(out.broker), broker);
  out.mqttPort = (uint16_t)port;
  copyStr(out.topicId, sizeof(out.topicId), topicId);
  lowerInPlace(out.topicId);
  copyStr(out.secret, sizeof(out.secret), secret);
  lowerInPlace(out.secret);
  copyStr(out.user, sizeof(out.user), user);
  copyStr(out.pass, sizeof(out.pass), pass);

  uint8_t index = 0;
  for (JsonVariant value : macArray) {
    if (index >= WOL_MAX_MACS) return false;
    const char* macText = value.as<const char*>();
    if (!macText) return false;
    char normalized[18];
    if (!normalizeMac(macText, normalized)) return false;
    for (uint8_t i = 0; i < index; i++) {
      if (strcmp(out.macs[i], normalized) == 0) return false;
    }
    copyStr(out.macs[index], sizeof(out.macs[index]), normalized);
    index++;
  }
  out.macCount = index;
  return index > 0;
}
