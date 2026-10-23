"""从 PWA 图标生成 Android 传统 launcher 图标。"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "web" / "icons" / "icon-512.png"
RES = ROOT / "android" / "res"

SIZES = {
    "mipmap-mdpi": 48,
    "mipmap-hdpi": 72,
    "mipmap-xhdpi": 96,
    "mipmap-xxhdpi": 144,
    "mipmap-xxxhdpi": 192,
}


def main() -> None:
    image = Image.open(SOURCE).convert("RGBA")
    for folder, size in SIZES.items():
        out_dir = RES / folder
        out_dir.mkdir(parents=True, exist_ok=True)
        out = image.resize((size, size), Image.LANCZOS)
        path = out_dir / "ic_launcher.png"
        out.save(path, "PNG", optimize=True)
        print(f"wrote {path} ({size}x{size})")


if __name__ == "__main__":
    main()
