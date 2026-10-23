"""生成 PWA 图标（深色渐变 + 青色电源符号）。运行：python tools/make_icons.py"""
from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "icons"
OUT.mkdir(parents=True, exist_ok=True)


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def background(size: int) -> Image.Image:
    top = (11, 18, 32)
    bottom = (5, 9, 18)
    img = Image.new("RGB", (size, size))
    pixels = img.load()
    for y in range(size):
        t = y / max(1, size - 1)
        r = int(lerp(top[0], bottom[0], t))
        g = int(lerp(top[1], bottom[1], t))
        b = int(lerp(top[2], bottom[2], t))
        for x in range(size):
            # 左上青色辉光
            dx = (x / size) - 0.22
            dy = (y / size) - 0.16
            glow = max(0.0, 1.0 - math.hypot(dx, dy) / 0.55) ** 2
            # 右下绿色微光
            dx2 = (x / size) - 0.86
            dy2 = (y / size) - 0.9
            glow2 = max(0.0, 1.0 - math.hypot(dx2, dy2) / 0.5) ** 2
            pixels[x, y] = (
                min(255, int(r + 30 * glow + 8 * glow2)),
                min(255, int(g + 74 * glow + 34 * glow2)),
                min(255, int(b + 84 * glow + 24 * glow2)),
            )
    return img


def gradient(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size))
    pixels = img.load()
    c1 = (103, 232, 249)   # cyan-300
    c2 = (52, 211, 153)    # emerald-400
    c3 = (125, 249, 255)
    for y in range(size):
        for x in range(size):
            t = max(0.0, min(1.0, (x / size) * 0.55 + (y / size) * 0.45))
            if t < 0.5:
                k = t / 0.5
                color = tuple(int(lerp(c1[i], c3[i], k)) for i in range(3))
            else:
                k = (t - 0.5) / 0.5
                color = tuple(int(lerp(c3[i], c2[i], k)) for i in range(3))
            pixels[x, y] = (*color, 255)
    return img


def glyph_mask(size: int, scale: float = 1.0) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    cx = size / 2
    cy = size * 0.545
    radius = size * 0.235 * scale
    width = max(2, int(size * 0.052 * scale))

    box = (cx - radius, cy - radius, cx + radius, cy + radius)
    # 顶部留缺口
    draw.arc(box, start=302, end=238, fill=255, width=width)

    # 中间的竖线
    stem_top = cy - radius * 1.12
    stem_bottom = cy - radius * 0.06
    draw.line((cx, stem_top, cx, stem_bottom), fill=255, width=width)
    r = width / 2
    draw.ellipse((cx - r, stem_top - r, cx + r, stem_top + r), fill=255)
    draw.ellipse((cx - r, stem_bottom - r, cx + r, stem_bottom + r), fill=255)
    return mask


def render(size: int, maskable: bool = False) -> Image.Image:
    base = background(size).convert("RGBA")

    # 外圈微光
    halo = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    hd = ImageDraw.Draw(halo)
    radius = size * 0.335
    box = (size / 2 - radius, size * 0.545 - radius, size / 2 + radius, size * 0.545 + radius)
    hd.ellipse(box, outline=(34, 211, 238, 26), width=max(2, int(size * 0.012)))
    base = Image.alpha_composite(base, halo)

    mask = glyph_mask(size, 0.92 if maskable else 1.0)

    # 发光层
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    glow.putalpha(mask.filter(ImageFilter.GaussianBlur(size * 0.045)))
    glow_color = Image.new("RGBA", (size, size), (34, 211, 238, 190))
    glow_color.putalpha(glow.getchannel("A"))
    base = Image.alpha_composite(base, glow_color)

    # 主符号
    grad = gradient(size)
    grad.putalpha(mask)
    base = Image.alpha_composite(base, grad)

    if not maskable:
        # 圆角矩形
        rounded = Image.new("L", (size, size), 0)
        ImageDraw.Draw(rounded).rounded_rectangle(
            (0, 0, size - 1, size - 1), radius=int(size * 0.22), fill=255
        )
        base.putalpha(rounded)

    return base


def main() -> None:
    outputs = {
        "icon-512.png": render(512, maskable=False),
        "icon-192.png": render(192, maskable=False),
        "maskable-512.png": render(512, maskable=True),
        "apple-touch-icon.png": render(180, maskable=False),
        "favicon-32.png": render(32, maskable=False),
    }
    for name, image in outputs.items():
        path = OUT / name
        image.save(path, "PNG", optimize=True)
        print(f"wrote {path} ({image.size[0]}x{image.size[1]})")


if __name__ == "__main__":
    main()
