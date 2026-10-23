#pragma once

// 固件版本与全局参数。修改后请同步 web/index.html 里的版本提示。
#define WOL_FW_VERSION "1.0.0"

#define WOL_SERIAL_BAUD 115200

// NodeMCU / Wemos D1 mini：板载 LED 在 GPIO2（低电平点亮），FLASH 键在 GPIO0。
// 注意：上电时按住 GPIO0 会进入串口下载模式，应用不会运行；按键请在启动后按。
#define WOL_LED_PIN 2
#define WOL_BUTTON_PIN 0

#define WOL_EEPROM_SIZE 512
#define WOL_EEPROM_MAGIC 0x574F4C31UL  // "WOL1"
#define WOL_CONFIG_VERSION 1

#define WOL_MAX_MACS 3

#define WOL_AP_PREFIX "WOL-"
#define WOL_PORTAL_TIMEOUT_MS (10UL * 60UL * 1000UL)
#define WOL_WIFI_CONNECT_TIMEOUT_MS 30000UL

#define WOL_MQTT_KEEPALIVE 30
#define WOL_MQTT_BUFFER_SIZE 512
#define WOL_STATUS_INTERVAL_MS 60000UL
#define WOL_COOLDOWN_MS 5000UL
#define WOL_TIME_WINDOW_SECONDS 600
#define WOL_NONCE_CACHE_SIZE 8

#define WOL_NTP_SERVER1 "ntp.aliyun.com"
#define WOL_NTP_SERVER2 "cn.pool.ntp.org"
#define WOL_NTP_SERVER3 "pool.ntp.org"
