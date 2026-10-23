#pragma once

#include <Arduino.h>
#include <EEPROM.h>
#include <ctype.h>
#include <string.h>
#include "app_config.h"

// 注意：这里不要放中文 display name。设备名称只存在网页端，
// 固件只需要协议必需字段，以减少 EEPROM 占用和解析风险。
struct Config {
  uint32_t magic;
  uint16_t version;
  char wifiSsid[33];
  char wifiPass[65];
  char broker[64];
  uint16_t mqttPort;
  char topicId[33];
  char secret[65];
  char macs[WOL_MAX_MACS][18];
  uint8_t macCount;
  char user[33];
  char pass[33];
  uint32_t checksum;
};

extern Config g_cfg;

static inline void copyStr(char* dst, size_t cap, const char* src) {
  if (cap == 0) return;
  if (!src) {
    dst[0] = '\0';
    return;
  }
  strncpy(dst, src, cap - 1);
  dst[cap - 1] = '\0';
}

static inline void trimInPlace(char* value) {
  if (!value) return;
  char* start = value;
  while (*start && isspace((unsigned char)*start)) start++;
  if (start != value) memmove(value, start, strlen(start) + 1);
  size_t len = strlen(value);
  while (len > 0 && isspace((unsigned char)value[len - 1])) value[--len] = '\0';
}

static inline bool isHexString(const char* value, size_t minLen, size_t maxLen) {
  if (!value) return false;
  size_t len = strlen(value);
  if (len < minLen || len > maxLen) return false;
  for (size_t i = 0; i < len; i++) {
    if (!isxdigit((unsigned char)value[i])) return false;
  }
  return true;
}

static inline void lowerInPlace(char* value) {
  if (!value) return;
  for (char* p = value; *p; p++) *p = (char)tolower((unsigned char)*p);
}

// AA-BB-CC-DD-EE-FF / aabbccddeeff -> AA:BB:CC:DD:EE:FF
static inline bool normalizeMac(const char* input, char out[18]) {
  if (!input || !out) return false;
  char hex[13];
  size_t n = 0;
  for (const char* p = input; *p; p++) {
    char c = *p;
    if (c == ':' || c == '-' || c == ' ' || c == '.' || c == '\t') continue;
    if (!isxdigit((unsigned char)c)) return false;
    if (n >= 12) return false;
    hex[n++] = (char)toupper((unsigned char)c);
  }
  if (n != 12) return false;
  snprintf(out, 18, "%c%c:%c%c:%c%c:%c%c:%c%c:%c%c",
           hex[0], hex[1], hex[2], hex[3], hex[4], hex[5],
           hex[6], hex[7], hex[8], hex[9], hex[10], hex[11]);
  return true;
}

static inline uint32_t crc32Bytes(const uint8_t* data, size_t len) {
  uint32_t crc = 0xFFFFFFFFUL;
  for (size_t i = 0; i < len; i++) {
    crc ^= data[i];
    for (uint8_t bit = 0; bit < 8; bit++) {
      crc = (crc >> 1) ^ (0xEDB88320UL & (uint32_t)(-(int32_t)(crc & 1)));
    }
  }
  return ~crc;
}

static inline uint32_t configChecksum(const Config& config) {
  return crc32Bytes(reinterpret_cast<const uint8_t*>(&config), sizeof(Config) - sizeof(config.checksum));
}

static inline bool configValid(const Config& config) {
  if (config.magic != WOL_EEPROM_MAGIC) return false;
  if (config.version != WOL_CONFIG_VERSION) return false;
  if (config.checksum != configChecksum(config)) return false;
  if (config.wifiSsid[0] == '\0' || strlen(config.wifiSsid) > 32) return false;
  if (strlen(config.wifiPass) > 64) return false;
  if (config.broker[0] == '\0' || strlen(config.broker) > 63) return false;
  if (config.mqttPort == 0) return false;
  if (!isHexString(config.topicId, 16, 32)) return false;
  if (!isHexString(config.secret, 64, 64)) return false;
  if (config.macCount == 0 || config.macCount > WOL_MAX_MACS) return false;
  for (uint8_t i = 0; i < config.macCount; i++) {
    char normalized[18];
    if (!normalizeMac(config.macs[i], normalized)) return false;
    if (strcmp(normalized, config.macs[i]) != 0) return false;
  }
  if (strlen(config.user) > 32) return false;
  if (strlen(config.pass) > 32) return false;
  return true;
}

static inline bool loadConfig() {
  EEPROM.begin(WOL_EEPROM_SIZE);
  EEPROM.get(0, g_cfg);
  return configValid(g_cfg);
}

static inline bool saveConfig() {
  g_cfg.magic = WOL_EEPROM_MAGIC;
  g_cfg.version = WOL_CONFIG_VERSION;
  g_cfg.checksum = configChecksum(g_cfg);
  EEPROM.put(0, g_cfg);
  return EEPROM.commit();
}

static inline void clearConfig() {
  memset(&g_cfg, 0, sizeof(g_cfg));
  EEPROM.put(0, g_cfg);
  EEPROM.commit();
}

static_assert(sizeof(Config) <= WOL_EEPROM_SIZE, "Config does not fit in EEPROM");
