#pragma once

#include <Arduino.h>
#include "app_config.h"

enum LedMode {
  LED_PORTAL,
  LED_WIFI,
  LED_MQTT,
  LED_ONLINE,
  LED_OFF,
};

static LedMode g_ledMode = LED_OFF;

static inline void ledInit() {
  pinMode(WOL_LED_PIN, OUTPUT);
  digitalWrite(WOL_LED_PIN, HIGH);
}

static inline void ledSetMode(LedMode mode) {
  g_ledMode = mode;
}

static inline void ledLoop() {
  unsigned long now = millis();
  bool on = false;
  switch (g_ledMode) {
    case LED_PORTAL:
      on = (now % 200UL) < 100UL;
      break;
    case LED_WIFI:
      on = (now % 1000UL) < 500UL;
      break;
    case LED_MQTT:
      on = (now % 400UL) < 200UL;
      break;
    case LED_ONLINE:
      on = true;
      break;
    case LED_OFF:
    default:
      on = false;
      break;
  }
  digitalWrite(WOL_LED_PIN, on ? LOW : HIGH);
}
