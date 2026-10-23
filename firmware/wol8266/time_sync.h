#pragma once

#include <Arduino.h>
#include <time.h>
#include "app_config.h"
#include "config_store.h"

extern bool g_timeSynced;

static unsigned long g_lastNtpAttempt = 0;

static inline void startTimeSync() {
  configTime(0, 0, WOL_NTP_SERVER1, WOL_NTP_SERVER2, WOL_NTP_SERVER3);
  g_lastNtpAttempt = millis();
  Serial.println("[ntp] sync requested");
}

static inline uint32_t nowSeconds() {
  time_t value = time(nullptr);
  if (value < 0) return 0;
  return (uint32_t)value;
}

static inline void updateTimeSync() {
  uint32_t now = nowSeconds();
  if (now > 1700000000UL) {
    if (!g_timeSynced) {
      g_timeSynced = true;
      Serial.printf("[ntp] synced, epoch=%lu\n", (unsigned long)now);
    }
    return;
  }
  if (millis() - g_lastNtpAttempt > 60000UL) {
    startTimeSync();
  }
}
