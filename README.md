# 远程开机（ESP8266 + MQTT + 安卓 App / PWA）

手机点一下 → 公共 MQTT Broker → 家里的 ESP8266 → 局域网 WOL 魔术包 → 电脑开机。
不需要公网 IP、端口映射或 PHP。

仓库提供两种入口：

- **安卓 App（推荐）**：内置网页的 WebView APK，不依赖网站/PWA/Service Worker，安装后可直接用。
- **网页 PWA**：把 `web/` 部署到任意静态主机（InfinityFree、Cloudflare Pages 等）。

## 目录

| 路径 | 内容 |
| --- | --- |
| `dist/wol-remote-1.0.3.apk` | 已签名的安卓安装包 |
| `android/` | 安卓源码、构建脚本、构建说明（见 [android/README.md](android/README.md)） |
| `web/` | 网页 PWA 源文件 |
| `firmware/wol8266/` | ESP8266 Arduino 源码 |
| `firmware/bin/` | 预编译 ESP8266 固件 |
| `tools/` | 固件构建、协议测试、局域网 WOL 测试、图标生成 |
| `tests/` | 网页协议/浏览器端到端测试 |

## 安卓 App

1. 把 `dist/wol-remote-1.0.3.apk` 传到手机，允许“安装未知应用”，安装。装过旧版（打开 not found）的，直接覆盖安装 1.0.3（versionCode 4，同签名），不用先卸载。
2. 如果之前已经在网页上配好 ESP：在旧网页 **设置与备份** 里复制设备码。
3. 打开 App → **已有设备码？导入** → 粘贴 → 进入控制台。
4. 设备显示在线后点 **开机**。

- App 内置 `web/`，由 WebView 的 `shouldInterceptRequest` 直接从 APK assets 读取，不启动本地 HTTP 服务、不经过 InfinityFree，也不受手机代理/VPN/端口影响。
- 首次导入设备码后保存在 App 本地；杀进程重开不需要再导。
- 如果没有旧设备码：在 App 里重新生成，然后按固件配网流程重新配 ESP。
- 构建/签名/更新说明见 [android/README.md](android/README.md)。

## 网页 PWA

把 `web/` 里的内容上传到静态主机的站点目录（例如 `htdocs/kaiji/`），访问对应 URL。

- 手机浏览器打开网页，生成设备码，复制。
- 手机连 ESP8266 的配网热点 `WOL-xxxx`，打开 `http://192.168.4.1`，填家里 WiFi + 设备码。
- 手机连回家里 WiFi，回网页点开机。

> InfinityFree 的反爬会对 `sw.js`、`manifest.webmanifest` 返回 HTML，导致 PWA 安装按钮不出现/报 MIME 错误。网页控制仍可用；要 PWA 安装，建议把 `web/` 放到 Cloudflare Pages / GitHub Pages / Netlify 等无抗反爬的静态主机，或直接用上面的安卓 App。

## ESP8266 固件

源码：`firmware/wol8266/`；预编译：`firmware/bin/wol8266-nodemcuv2-4m.bin`（4MB NodeMCU / D1 mini）。

```bash
python -m esptool --port COMx --baud 460800 write-flash --flash-mode dio --flash-freq 40m --flash-size 4MB 0x0 firmware/bin/wol8266-nodemcuv2-4m.bin
```

- **不要用 `erase-flash` 整片擦除**；会清掉 RF 初始化数据，导致热点/启动异常。正常 `write-flash` 只写应用区。
- 如果整片擦除后不断重启，把 ESP8266 core 里的 `esp_init_data_default.bin` 写回 `0x3FC000` 后重启。
- Arduino IDE 方式：ESP8266 core 3.1.2 + PubSubClient 2.8.0 + ArduinoJson 7.2.1，打开 `firmware/wol8266/wol8266.ino` 上传。
- 配网热点只在“未配置/重新配网”时出现；正常连上 WiFi 后热点会关闭。重新配网：上电等 10 秒，再长按 FLASH/GPIO0 5 秒（不要在刚上电时按住）。

## 电脑 WOL 设置

- BIOS：开启 **Wake on LAN / Power On By PCI-E**，关闭 **ErP / EuP / Deep Sleep**。
- Windows 网卡高级设置：开启“魔术封包唤醒”“关机 网络唤醒”；关机连接速度可设 10 Mbps 优先。
- 关闭 Windows 快速启动（或 `powercfg /h off`）。
- 电脑用**网线**连接路由器；关机后网口灯应仍亮/闪。
- 用 `getmac /v` 查有线网卡 MAC，填入网页/App。

## 必须在同一局域网

WOL 是二层广播，跨路由器/跨网段不会被转发。ESP8266 的 WiFi 和电脑有线网卡必须在**同一网段**（例如都在 `192.168.1.x`）。如果 ESP 在 `192.168.0.x`、电脑有线在 `192.168.1.x`，页面提示“设备已确认”但电脑不会醒。

修法：把电脑网线接到 ESP 所在的 WiFi 路由器、把 ESP 配到电脑有线所在路由器的 WiFi，或把二级路由器改成 AP/桥接模式统一网段。

不经过 ESP 的验证：

```bash
python tools/send_wol.py <电脑有线MAC> --broadcast 192.168.1.255
```

## 安全说明

- 设备码包含 32 字节随机密钥；命令用 HMAC-SHA256 签名，带 10 分钟时间窗 + nonce 防重放。
- 默认公共 Broker `broker.emqx.io`（MQTTS 8883 / WSS 8084）；公共 Broker 上别人可看到 topic/消息，但无法伪造命令。要更私密可在网页高级设置里换自建 Mosquitto/EMQX（需 TLS + WSS）。
- 设备码等于密码，不要公开；App 的 `allowBackup=false`，卸载/换机会丢失，需重新导入或重新配网。
- APK 使用本地自签名证书，不是 Play Store 分发；更新需同一签名 key（keystore 不入库，见 android/README）。

## 测试/构建

```bash
pnpm install
pnpm test                 # 协议/单元测试
pnpm run test:e2e         # 本地 MQTT + 无头浏览器（需 Chrome，未找到会跳过）
node tools/bundle_app.mjs android/prebuilt/app.bundle.js
powershell -ExecutionPolicy Bypass -File android/build_apk.ps1
```

## 许可

MIT。`web/vendor/mqtt.min.js` 来自 mqtt.js（MIT），见 `web/vendor/README.md`。
