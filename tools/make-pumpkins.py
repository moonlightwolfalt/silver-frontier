#!/usr/bin/env python3
"""Builds the custom pumpkin variants from mope.io's own pumpkin frames.

mope.io's pumpkin variants (normal, jack, gold, emerald, ruby, diamond, onyx) are recolours of
the same 5 rolling-animation frames: assets/terrain/pumpkin/<variant>/0..4.webp, 284x286. This
script fetches ruby's frames and recolours them with the colours of the artwork in
custom-assets/source/, so every new variant has exactly the same frames, outline, ridges and
highlight as the originals:

  amber, sapphire, amethyst  each pixel keeps ruby's brightness and saturation relative to
                             ruby's base colour, moved onto the artwork's colour
  black_hole                 near-black body with purple ridges, plus the artwork's stars and
                             purple ring, clipped to each frame's silhouette

Output: custom-assets/terrain/pumpkin/<variant>/<frame>.webp (served by server.js).
Usage: python3 tools/make-pumpkins.py      (needs Pillow: pip install -r requirements.txt)
"""
import colorsys
import io
import urllib.request
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "custom-assets" / "source"
OUT = ROOT / "custom-assets" / "terrain" / "pumpkin"
FRAMES = 5
RUBY_BASE = (224, 30, 49)  # ruby's main fill colour
COLOURS = {  # main fill colour of each uploaded pumpkin
    "amber": (252, 107, 1),
    "sapphire": (0, 42, 166),
    "amethyst": (57, 11, 113),
}
BLACK_HOLE_FILL = (6, 4, 9)
BLACK_HOLE_RIDGE = (45, 10, 82)


def fetch_frame(variant, n):
    url = f"https://mope.io/assets/terrain/pumpkin/{variant}/{n}.webp"
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=30) as r:
        if "image" not in r.headers.get("Content-Type", ""):
            raise RuntimeError(f"{url} is not an image")
        return Image.open(io.BytesIO(r.read())).convert("RGBA")


def hsv(rgb):
    return colorsys.rgb_to_hsv(*(c / 255 for c in rgb))


def recolour(frame, target):
    """Moves every pixel from ruby's colour onto `target`, keeping its relative shading."""
    bh, bs, bv = hsv(RUBY_BASE)
    th, ts, tv = hsv(target)
    out = frame.copy()
    px = out.load()
    for y in range(out.height):
        for x in range(out.width):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            _, s, v = hsv((r, g, b))
            ns = min(1.0, ts * s / bs) if bs else ts
            nv = min(1.0, tv * v / bv) if bv else tv
            nr, ng, nb = colorsys.hsv_to_rgb(th, ns, nv)
            px[x, y] = (round(nr * 255), round(ng * 255), round(nb * 255), a)
    return out


def art_layer(path, frame):
    """The artwork scaled onto the frame: its pumpkin's bounding box onto the frame's."""
    art = Image.open(path).convert("RGB")
    mask = art.convert("L").point(lambda v: 255 if v > 12 else 0)
    box = mask.getbbox()
    fbox = frame.getchannel("A").getbbox()
    art = art.crop(box).resize((fbox[2] - fbox[0], fbox[3] - fbox[1]), Image.LANCZOS)
    layer = Image.new("RGB", frame.size)
    layer.paste(art, fbox[:2])
    return layer


def black_hole(frame, art):
    """Dark body with purple ridges, then the artwork's stars and ring on top."""
    bv = hsv(RUBY_BASE)[2]
    out = frame.copy()
    px, ap = out.load(), art.load()
    for y in range(out.height):
        for x in range(out.width):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            v = hsv((r, g, b))[2] / bv
            # ruby's darker pixels are its outline and ridges
            base = BLACK_HOLE_RIDGE if v < 0.93 else tuple(min(255, round(c * max(1.0, v) ** 4)) for c in BLACK_HOLE_FILL)
            sr, sg, sb = ap[x, y]
            if max(sr, sg, sb) >= 120:  # stars and the purple ring; skips the art's dark outlines
                base = (sr, sg, sb)
            px[x, y] = (*base, a)
    return out


def main():
    ruby = [fetch_frame("ruby", n) for n in range(FRAMES)]
    for name, colour in COLOURS.items():
        (OUT / name).mkdir(parents=True, exist_ok=True)
        for n, frame in enumerate(ruby):
            recolour(frame, colour).save(OUT / name / f"{n}.webp", lossless=True)
        print("made", name)
    (OUT / "black_hole").mkdir(parents=True, exist_ok=True)
    art = art_layer(SOURCE / "black_hole.png", ruby[0])
    for n, frame in enumerate(ruby):
        black_hole(frame, art).save(OUT / "black_hole" / f"{n}.webp", lossless=True)
    print("made black_hole")


if __name__ == "__main__":
    main()
