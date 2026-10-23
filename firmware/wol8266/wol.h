#pragma once

#include <Arduino.h>
#include <WiFiUdp.h>
#include <ESP8266WiFi.h>
#include <string.h>
#include "config_store.h"

extern WiFiUDP g_udp;

static inline bool macToBytes(const char* mac, uint8_t out[6]) {
  char normalized[18];
  if (!normalizeMac(mac, normalized)) return false;
  for (uint8_t i = 0; i < 6; i++) {
    char pair[3] = {normalized[i * 3], normalized[i * 3 + 1], '\0'};
    out[i] = (uint8_t)strtoul(pair, nullptr, 16);
  }
  return true;
}

static inline void sendPacketTo(const IPAddress& target, uint16_t port, const uint8_t packet[102]) {
  if (!g_udp.beginPacket(target, port)) return;
  g_udp.write(packet, 102);
  g_udp.endPacket();
}

static inline void sendWake(const char* macText) {
  uint8_t mac[6];
  if (!macToBytes(macText, mac)) {
    Serial.printf("[wol] invalid mac: %s\n", macText ? macText : "(null)");
    return;
  }

  uint8_t packet[102];
  memset(packet, 0xFF, 6);
  for (uint8_t i = 0; i < 16; i++) {
    memcpy(packet + 6 + i * 6, mac, 6);
  }

  IPAddress local = WiFi.localIP();
  IPAddress mask = WiFi.subnetMask();
  IPAddress directed(
      (uint8_t)(local[0] | (uint8_t)~mask[0]),
      (uint8_t)(local[1] | (uint8_t)~mask[1]),
      (uint8_t)(local[2] | (uint8_t)~mask[2]),
      (uint8_t)(local[3] | (uint8_t)~mask[3]));

  Serial.printf("[wol] magic -> %s (bcast %u.%u.%u.%u)\n", macText,
                directed[0], directed[1], directed[2], directed[3]);

  for (uint8_t round = 0; round < 2; round++) {
    // 255.255.255.255 在部分路由器上会被丢弃，所以同时发定向广播。
    sendPacketTo(IPAddress(255, 255, 255, 255), 9, packet);
    sendPacketTo(IPAddress(255, 255, 255, 255), 7, packet);
    sendPacketTo(directed, 9, packet);
    sendPacketTo(directed, 7, packet);
    delay(60);
  }
}
