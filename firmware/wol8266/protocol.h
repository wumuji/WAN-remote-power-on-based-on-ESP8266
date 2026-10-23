#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include <string.h>
#include "app_config.h"
#include "config_store.h"
#include "hmac_sha256.h"
#include "time_sync.h"

struct CommandResult {
  bool ok;
  const char* error;
  char id[9];
  char mac[18];
  uint32_t ts;
};

static char g_nonceCache[WOL_NONCE_CACHE_SIZE][33];
static uint8_t g_nonceCount = 0;
static uint8_t g_nonceNext = 0;

static inline bool nonceWasSeen(const char* nonce) {
  for (uint8_t i = 0; i < g_nonceCount; i++) {
    if (strcmp(g_nonceCache[i], nonce) == 0) return true;
  }
  return false;
}

static inline void nonceRemember(const char* nonce) {
  copyStr(g_nonceCache[g_nonceNext], sizeof(g_nonceCache[g_nonceNext]), nonce);
  g_nonceNext = (uint8_t)((g_nonceNext + 1) % WOL_NONCE_CACHE_SIZE);
  if (g_nonceCount < WOL_NONCE_CACHE_SIZE) g_nonceCount++;
}

static inline bool macAllowed(const char* mac) {
  for (uint8_t i = 0; i < g_cfg.macCount; i++) {
    if (strcmp(g_cfg.macs[i], mac) == 0) return true;
  }
  return false;
}

// 校验 MQTT 命令。返回 false 时 result.error 指向错误码。
static inline bool verifyCommand(const char* payload, size_t length, CommandResult& result) {
  memset(&result, 0, sizeof(result));
  result.error = "json";

  if (!payload || length == 0 || length > 480) return false;

  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, payload, length);
  if (error) return false;

  if ((int)(doc["v"] | 0) != 1) {
    result.error = "command";
    return false;
  }

  const char* action = doc["a"] | "";
  if (strcmp(action, "wake") != 0) {
    result.error = "command";
    return false;
  }

  const char* id = doc["id"] | "";
  if (!isHexString(id, 8, 8)) {
    result.error = "id";
    return false;
  }
  copyStr(result.id, sizeof(result.id), id);

  const char* macText = doc["m"] | "";
  char normalized[18];
  if (!normalizeMac(macText, normalized)) {
    result.error = "mac";
    return false;
  }
  copyStr(result.mac, sizeof(result.mac), normalized);
  if (!macAllowed(normalized)) {
    result.error = "mac";
    return false;
  }

  uint32_t ts = doc["ts"] | 0UL;
  if (ts == 0) {
    result.error = "time";
    return false;
  }
  result.ts = ts;

  if (g_timeSynced) {
    int32_t delta = (int32_t)(nowSeconds() - ts);
    if (delta > WOL_TIME_WINDOW_SECONDS || delta < -WOL_TIME_WINDOW_SECONDS) {
      result.error = "time";
      return false;
    }
  }

  const char* nonce = doc["n"] | "";
  if (!isHexString(nonce, 8, 32)) {
    result.error = "nonce";
    return false;
  }
  if (nonceWasSeen(nonce)) {
    result.error = "replay";
    return false;
  }

  const char* signature = doc["sig"] | "";
  if (!isHexString(signature, 64, 64)) {
    result.error = "sig";
    return false;
  }

  char canonical[192];
  snprintf(canonical, sizeof(canonical), "v1|wake|%s|%lu|%s|%s",
           normalized, (unsigned long)ts, nonce, id);

  char expected[65];
  hmacSha256Hex(g_cfg.secret, canonical, expected);
  if (!constantTimeEqualHex(expected, signature)) {
    result.error = "sig";
    return false;
  }

  nonceRemember(nonce);
  result.ok = true;
  result.error = "";
  return true;
}
