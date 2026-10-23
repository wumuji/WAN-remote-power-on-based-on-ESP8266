#!/usr/bin/env python3
"""直接发 WOL 魔术包，用来单独验证电脑的 Wake-on-LAN 设置。

用法：
    python tools/send_wol.py 30:C5:99:84:6A:6E
    python tools/send_wol.py AA:BB:CC:DD:EE:FF --broadcast 192.168.1.255
    python tools/send_wol.py AA:BB:CC:DD:EE:FF --port 7
"""
from __future__ import annotations

import argparse
import socket
import sys


def parse_mac(value: str) -> bytes:
    hex_text = "".join(ch for ch in value if ch.isalnum()).upper()
    if len(hex_text) != 12:
        raise argparse.ArgumentTypeError("MAC 必须是 12 位十六进制，例如 AA:BB:CC:DD:EE:FF")
    try:
        return bytes(int(hex_text[i : i + 2], 16) for i in range(0, 12, 2))
    except ValueError as exc:
        raise argparse.ArgumentTypeError("MAC 里有非十六进制字符") from exc


def candidate_broadcasts() -> set[str]:
    """枚举本机私网 IPv4，按常见 /24 推导定向广播地址。

    不依赖默认路由，避免 VPN/代理网卡把包带偏；家庭局域网最常见的是 /24。
    如果实际不是 /24，请用 --broadcast 显式指定。
    """
    result: set[str] = set()
    try:
        infos = socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)
        for info in infos:
            ip = info[4][0]
            parts = ip.split(".")
            if len(parts) != 4:
                continue
            first, second = int(parts[0]), int(parts[1])
            private = first == 10 or (first == 192 and second == 168) or (
                first == 172 and 16 <= second <= 31
            )
            if private:
                result.add(".".join(parts[:3] + ["255"]))
    except OSError:
        pass
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="发送 Wake-on-LAN 魔术包")
    parser.add_argument("mac", type=parse_mac, help="目标网卡 MAC，例如 AA:BB:CC:DD:EE:FF")
    parser.add_argument("--broadcast", action="append", default=[], help="额外广播地址，可多次指定")
    parser.add_argument("--port", type=int, default=9, help="UDP 端口，默认 9（同时发 7）")
    args = parser.parse_args()

    packet = b"\xff" * 6 + args.mac * 16
    targets = set(args.broadcast)
    targets.add("255.255.255.255")
    targets.update(candidate_broadcasts())

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    ports = {args.port}
    ports.add(7)

    print("magic packet:", packet.hex())
    for target in sorted(targets):
        for port in sorted(ports):
            try:
                sock.sendto(packet, (target, port))
                print(f"sent -> {target}:{port}")
            except OSError as exc:
                print(f"failed -> {target}:{port}: {exc}")
    sock.close()
    print("done. 如果电脑没醒，检查 BIOS ErP、网卡 WOL 和是否同一网段。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
