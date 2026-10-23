#pragma once

#include <Arduino.h>
#include <bearssl/bearssl_hash.h>
#include <bearssl/bearssl_hmac.h>

// 使用 ESP8266 核心自带的 BearSSL 实现 HMAC-SHA256。
// 密钥是 ASCII 形式的 64 位十六进制字符串（与网页端一致）。

static inline void hmacSha256(const void* key, size_t keyLen,
                              const void* message, size_t messageLen,
                              uint8_t out[32]) {
  br_hmac_key_context keyContext;
  br_hmac_key_init(&keyContext, &br_sha256_vtable, key, keyLen);
  br_hmac_context context;
  br_hmac_init(&context, &keyContext, 0);
  br_hmac_update(&context, message, messageLen);
  br_hmac_out(&context, out);
}

static inline void bytesToHexLower(const uint8_t* bytes, size_t len, char* out) {
  static const char* digits = "0123456789abcdef";
  for (size_t i = 0; i < len; i++) {
    out[i * 2] = digits[bytes[i] >> 4];
    out[i * 2 + 1] = digits[bytes[i] & 0x0F];
  }
  out[len * 2] = '\0';
}

static inline void hmacSha256Hex(const char* key, const char* message, char out[65]) {
  uint8_t digest[32];
  hmacSha256(key, strlen(key), message, strlen(message), digest);
  bytesToHexLower(digest, sizeof(digest), out);
}

static inline bool constantTimeEqualHex(const char* left, const char* right) {
  if (!left || !right) return false;
  size_t aLen = strlen(left);
  size_t bLen = strlen(right);
  if (aLen != bLen) return false;
  uint8_t diff = 0;
  for (size_t i = 0; i < aLen; i++) {
    diff |= (uint8_t)(tolower((unsigned char)left[i]) ^ tolower((unsigned char)right[i]));
  }
  return diff == 0;
}

static inline bool hmacSelfTest() {
  // HMAC-SHA256("key", "The quick brown fox jumps over the lazy dog")
  const char* expected = "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8";
  char actual[65];
  hmacSha256Hex("key", "The quick brown fox jumps over the lazy dog", actual);
  bool ok = constantTimeEqualHex(actual, expected);
  Serial.printf("[hmac] selftest %s\n", ok ? "OK" : "FAILED");
  if (!ok) Serial.printf("[hmac] got %s\n", actual);
  return ok;
}
