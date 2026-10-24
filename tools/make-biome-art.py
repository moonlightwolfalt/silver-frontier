#!/usr/bin/env python3
"""Draws the sprites for the custom biomes in custom-biomes.json, in mope.io's style.

mope.io's animals are flat, two-tone, top-down drawings: a darker rim around a lighter body, big
black eyes with a white glint, the head at the bottom of a 500x500 image and the tail at the top.
Foods are 300x300 with a thick outline: the biome's colour normally, light green when edible.

Each animal is built from a body plan (fish, bird, mammal, dragon, ...) plus a few features, so
the 68 animals share one look. Everything is drawn 4x larger and scaled down for smooth edges.

Usage: python3 tools/make-biome-art.py [--only slug,slug] [--sheet out.png]
Writes custom-assets/animals/<biome>/<slug>/{body,<slug>.ui}.webp and
custom-assets/foods/<slug>/{<slug>,edible}.webp.
"""
import json
import math
import random
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
DATA = json.loads((ROOT / "custom-biomes.json").read_text())
OUT = ROOT / "custom-assets"

K = 4  # supersampling
A = 500 * K  # animal canvas
C = A // 2


def hexc(h, a=255):
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), a)


def shade(col, f):
    r, g, b, a = col
    if f < 1:
        return (int(r * f), int(g * f), int(b * f), a)
    return (int(r + (255 - r) * (f - 1)), int(g + (255 - g) * (f - 1)), int(b + (255 - b) * (f - 1)), a)


# ---------- primitives (coordinates in 500-px units, y down, head at the bottom) ----------

class Pen:
    def __init__(self, size=A):
        self.img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        self.d = ImageDraw.Draw(self.img)

    def ell(self, x, y, rx, ry, col, rot=0):
        if rot == 0:
            self.d.ellipse([(x - rx) * K, (y - ry) * K, (x + rx) * K, (y + ry) * K], fill=col)
            return
        pts = []
        for i in range(64):
            t = i / 64 * 2 * math.pi
            px, py = rx * math.cos(t), ry * math.sin(t)
            pts.append(((x + px * math.cos(rot) - py * math.sin(rot)) * K, (y + px * math.sin(rot) + py * math.cos(rot)) * K))
        self.d.polygon(pts, fill=col)

    def circle(self, x, y, r, col):
        self.ell(x, y, r, r, col)

    def poly(self, pts, col):
        self.d.polygon([(x * K, y * K) for x, y in pts], fill=col)

    def line(self, pts, col, w):
        self.d.line([(x * K, y * K) for x, y in pts], fill=col, width=int(w * K), joint="curve")
        for x, y in (pts[0], pts[-1]):
            self.circle(x, y, w / 2, col)

    def tube(self, pts, r0, r1, dark, main):
        """A body along a path: circles shrinking from r0 to r1, rim then fill."""
        dense = []
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
            steps = max(1, int(math.hypot(x1 - x0, y1 - y0) / 3))
            dense += [(x0 + (x1 - x0) * t / steps, y0 + (y1 - y0) * t / steps) for t in range(steps)]
        pts = dense + [pts[-1]]
        n = len(pts)
        for col, inset in ((dark, 0), (main, 0.22)):
            for i, (x, y) in enumerate(pts):
                r = r0 + (r1 - r0) * i / max(1, n - 1)
                self.circle(x, y, r * (1 - inset), col)


def two_tone(p, fn, dark, main, inset=0.84):
    """Draws a shape twice: dark, then main scaled in (mope's rim)."""
    fn(dark, 1.0)
    fn(main, inset)


def eyes(p, x, y, spread, r, glint=True):
    for s in (-1, 1):
        p.circle(x + s * spread, y, r, (0, 0, 0, 255))
        if glint:
            p.circle(x + s * spread - r * 0.35, y - r * 0.35, r * 0.3, (255, 255, 255, 255))


def spots(p, cx, cy, rx, ry, col, n=7, seed=1, rmin=8, rmax=16):
    rnd = random.Random(seed)
    for _ in range(n):
        a, d = rnd.random() * 2 * math.pi, rnd.random() ** 0.5
        p.circle(cx + math.cos(a) * rx * d * 0.75, cy + math.sin(a) * ry * d * 0.75, rnd.uniform(rmin, rmax), col)


def stars(p, cx, cy, rx, ry, n=10, seed=3):
    rnd = random.Random(seed)
    for _ in range(n):
        a, d = rnd.random() * 2 * math.pi, rnd.random() ** 0.5
        x, y, r = cx + math.cos(a) * rx * d * 0.8, cy + math.sin(a) * ry * d * 0.8, rnd.uniform(3, 7)
        p.poly(star_pts(x, y, r * 2.2, r * 0.8, 4), (255, 255, 240, 230))


def star_pts(x, y, ro, ri, n=5, rot=-math.pi / 2):
    pts = []
    for i in range(n * 2):
        r = ro if i % 2 == 0 else ri
        t = rot + i * math.pi / n
        pts.append((x + r * math.cos(t), y + r * math.sin(t)))
    return pts


def wing(p, side, x, y, length, width, angle, dark, main, kind="feather"):
    """A wing pointing out to one side (side=-1 left, 1 right), angle tilts it toward the tail."""
    rot = angle * side
    ang = (0 if side > 0 else math.pi) - rot
    wx, wy = x + math.cos(ang) * length * 0.5, y + math.sin(ang) * length * 0.5
    if kind == "membrane":
        tip = (x + math.cos(ang) * length, y + math.sin(ang) * length)
        pts = [(x, y - width * 0.6), tip, (x + math.cos(ang) * length * 0.7, y + width * 0.2),
               (x + math.cos(ang) * length * 0.45, y + width * 0.55), (x, y + width * 0.6)]
        p.poly(pts, dark)
        inner = [(x + (px - x) * 0.85, y + (py - y) * 0.85) for px, py in pts]
        p.poly(inner, main)
        return
    p.ell(wx, wy, length * 0.55, width, dark, rot=ang)
    p.ell(wx, wy, length * 0.47, width * 0.78, main, rot=ang)
    if kind == "feather":
        for i in range(3):
            f = 0.55 + i * 0.17
            p.ell(x + math.cos(ang) * length * f, y + math.sin(ang) * length * f + width * 0.35, length * 0.12, width * 0.35, shade(main, 0.88), rot=ang)


# ---------- body plans ----------

def plan_mammal(p, c, feats, big=1.0):
    dark, main, light, acc = c
    feats = set(feats)
    # tail (top)
    if "tail_comet" in feats:
        for i, (r, col) in enumerate(((70, light), (52, acc), (34, (255, 255, 255, 255)))):
            p.ell(250, 95 + i * 10, r * 0.75, r * 1.25, col)
    elif "tail_thick" in feats:
        p.tube([(250, 70 + i * 22) for i in range(7)], 22, 36, dark, main)
    elif "tail_puff" in feats:
        p.circle(250, 105, 34, dark)
        p.circle(250, 105, 27, light)
    elif "tail_stub" in feats:
        p.circle(250, 120, 22, dark)
    else:
        p.line([(250, 165), (240, 120), (265, 85), (300, 60)], dark, 12)
    # ears
    if "ears_long" in feats:
        for s in (-1, 1):
            p.ell(250 + s * 70, 120, 38, 95, dark, rot=s * 0.25)
            p.ell(250 + s * 70, 125, 24, 72, acc, rot=s * 0.25)
    elif "ears_pointed" in feats:
        for s in (-1, 1):
            p.poly([(250 + s * 55, 200), (250 + s * 140, 110), (250 + s * 150, 250)], dark)
            p.poly([(250 + s * 75, 205), (250 + s * 132, 140), (250 + s * 135, 240)], shade(main, 1.15))
    elif "ears_small" in feats:
        for s in (-1, 1):
            p.circle(250 + s * 115, 210, 32, dark)
            p.circle(250 + s * 115, 210, 20, shade(main, 1.1))
    elif "ears_round" in feats:
        for s in (-1, 1):
            p.circle(250 + s * 105, 205, 58, dark)
            p.circle(250 + s * 105, 205, 40, shade(main, 1.2))
    # body + head
    p.circle(250, 265, 165 * big, dark)
    p.circle(250, 265, 145 * big, main)
    if "stripes" in feats:
        p.ell(250, 290, 26, 150, light)
        for s in (-1, 1):
            p.ell(250 + s * 82, 300, 14, 110, light)
    p.ell(250, 330, 105, 95, shade(main, 1.12))
    if "claws" in feats:
        for s in (-1, 1):
            for i in range(3):
                p.ell(250 + s * (120 + i * 16), 395 - i * 8, 10, 30, acc, rot=s * 0.4)
    # snout
    p.ell(250, 400, 52, 48, shade(main, 1.2))
    p.circle(250, 438, 15, dark)
    if "teeth" in feats:
        p.poly([(238, 446), (262, 446), (258, 470), (242, 470)], acc)
    eyes(p, 250, 350, 52, 30)


def plan_glider(p, c, feats):
    dark, main, light, acc = c
    # membrane square spread between legs
    p.poly([(80, 150), (420, 150), (440, 360), (60, 360)], dark)
    p.poly([(100, 165), (400, 165), (418, 345), (82, 345)], main)
    p.tube([(250, 60 + i * 20) for i in range(6)], 20, 30, dark, light)
    plan_mammal(p, c, ["ears_round", "tail_stub"], big=0.75)


def plan_bird(p, c, feats):
    dark, main, light, acc = c
    feats = set(feats)
    long = "wings_long" in feats
    if "fire" in feats:
        for i, col in enumerate((hexc("#ff5a1a"), acc)):
            for s in (-1, 1):
                p.poly([(250, 200), (250 + s * (245 - i * 30), 140 + i * 20), (250 + s * 120, 320)], col)
    # tail feathers
    if "tail_fork" in feats:
        for s in (-1, 1):
            p.poly([(250, 150), (250 + s * 70, 20), (250 + s * 25, 160)], dark)
    else:
        p.poly([(200, 170), (300, 170), (330, 50), (170, 50)], dark)
        p.poly([(212, 165), (288, 165), (310, 70), (190, 70)], main)
    for s in (-1, 1):
        wing(p, s, 250 + s * 60, 240, 185 if long else 160, 58 if long else 68, 0.35, dark, main)
        if "wingtips" in feats:
            p.ell(250 + s * 190, 185, 34, 26, hexc("#222222"), rot=s * 0.35)
    if "lightning" in feats:
        for s in (-1, 1):
            p.poly([(250 + s * 120, 170), (250 + s * 170, 230), (250 + s * 140, 235), (250 + s * 190, 300), (250 + s * 120, 225), (250 + s * 150, 222)], acc)
    p.ell(250, 270, 110, 135, dark)
    p.ell(250, 270, 94, 118, main)
    p.ell(250, 300, 70, 80, light)
    if "ruff" in feats:
        p.ell(250, 330, 95, 40, light)
    # head
    p.circle(250, 360, 70, dark)
    p.circle(250, 360, 58, main if "ruff" not in feats else acc)
    if "crown" in feats:
        p.circle(250, 340, 22, acc)
    if "crest" in feats:
        for s in (-1, 0, 1):
            p.poly([(250 + s * 30, 330), (250 + s * 55, 270), (250 + s * 10, 320)], dark)
    beak = acc if acc[0] + acc[1] > 200 else hexc("#f0b030")
    if "beak_needle" in feats:
        p.poly([(240, 400), (260, 400), (252, 490), (248, 490)], beak)
    elif "beak_long" in feats:
        p.poly([(230, 395), (270, 395), (255, 485), (245, 485)], beak)
    else:
        p.poly([(225, 400), (275, 400), (250, 445)], beak)
    eyes(p, 250, 370, 34, 19)


def plan_bat(p, c, feats):
    dark, main, light, acc = c
    for s in (-1, 1):
        wing(p, s, 250 + s * 60, 250, 230, 120, 0.15, acc, main, kind="membrane")
    for s in (-1, 1):
        p.poly([(250 + s * 30, 200), (250 + s * 85, 120), (250 + s * 90, 230)], dark)
    p.circle(250, 270, 95, dark)
    p.circle(250, 270, 80, main)
    p.ell(250, 330, 60, 55, light)
    p.poly([(236, 372), (246, 372), (241, 392)], (255, 255, 255, 255))
    p.poly([(254, 372), (264, 372), (259, 392)], (255, 255, 255, 255))
    eyes(p, 250, 320, 32, 18)


def plan_fish(p, c, feats):
    dark, main, light, acc = c
    feats = set(feats)
    p.poly([(250, 150), (160, 30), (250, 80), (340, 30)], dark)  # tail fin
    if "fins" in feats or "shark" in feats:
        for s in (-1, 1):
            p.poly([(250 + s * 70, 260), (250 + s * 175, 330), (250 + s * 80, 330)], dark)
    if "shark" in feats:
        p.poly([(250, 200), (220, 300), (280, 300)], dark)
    p.ell(250, 270, 105, 175, dark)
    p.ell(250, 270, 88, 158, main)
    p.ell(250, 300, 52, 110, light)
    if "spots" in feats:
        spots(p, 250, 230, 80, 120, acc, n=8, seed=5)
    if "snout" in feats:
        p.ell(250, 440, 34, 60, dark)
        p.ell(250, 440, 24, 50, main)
    eyes(p, 250, 375, 48, 24)


def plan_ray(p, c, feats):
    dark, main, light, acc = c
    p.line([(250, 200), (255, 120), (240, 40), (250, 10)], dark, 10)
    p.poly([(250, 140), (470, 290), (250, 430), (30, 290)], dark)
    p.poly([(250, 160), (440, 290), (250, 410), (60, 290)], main)
    p.ell(250, 300, 70, 90, light)
    if "stars" in set(feats):
        stars(p, 250, 290, 160, 100)
    eyes(p, 250, 360, 40, 18)


def plan_whale(p, c, feats):
    dark, main, light, acc = c
    for s in (-1, 1):
        p.ell(250 + s * 70, 50, 70, 26, dark, rot=s * 0.3)
    p.tube([(250, 70 + i * 15) for i in range(6)], 26, 50, dark, main)
    for s in (-1, 1):
        p.ell(250 + s * 160, 300, 85, 30, dark, rot=s * 0.5)
    p.ell(250, 290, 150, 200, dark)
    p.ell(250, 290, 132, 182, main)
    p.ell(250, 330, 80, 140, light)
    for i in range(4):
        p.line([(220 + i * 20, 380), (220 + i * 20, 460)], shade(light, 0.85), 5)
    if "stars" in set(feats):
        stars(p, 250, 260, 120, 160, n=14)
    eyes(p, 250, 405, 88, 22)


def plan_insect(p, c, feats):
    dark, main, light, acc = c
    feats = set(feats)
    if "wings_butterfly" in feats:
        for s in (-1, 1):
            p.ell(250 + s * 120, 200, 115, 100, dark, rot=s * 0.4)
            p.ell(250 + s * 120, 200, 98, 84, main, rot=s * 0.4)
            p.circle(250 + s * 140, 190, 30, acc)
            p.ell(250 + s * 95, 320, 75, 60, dark, rot=-s * 0.3)
            p.ell(250 + s * 95, 320, 60, 46, light, rot=-s * 0.3)
    elif "wings4" in feats:
        for s in (-1, 1):
            for dy, ln in ((210, 200), (275, 180)):
                p.ell(250 + s * 120, dy, ln * 0.55, 34, shade(light, 1.0)[:3] + (190,), rot=s * 0.12)
    else:
        for s in (-1, 1):
            for i in range(3):
                y = 230 + i * 55
                p.line([(250 + s * 40, y), (250 + s * 120, y - 30 + i * 25), (250 + s * 165, y + 15 + i * 15)], dark, 12)
    if "antennae_long" in feats or "wings_butterfly" in feats or True:
        ln = 150 if "antennae_long" in feats else 70
        for s in (-1, 1):
            p.line([(250 + s * 15, 420), (250 + s * 45, 420 + ln * 0.45), (250 + s * 70, 420 + ln * 0.6)], dark, 7)
    # abdomen, thorax, head
    p.ell(250, 170, 62, 95, dark)
    p.ell(250, 170, 52, 84, main)
    if "shell" in feats:
        p.ell(250, 230, 110, 150, dark)
        p.ell(250, 230, 96, 136, main)
        p.line([(250, 95), (250, 360)], dark, 8)
        p.ell(205, 190, 22, 60, light)
    p.circle(250, 300, 58, dark)
    p.circle(250, 300, 48, main)
    p.circle(250, 380, 52, dark)
    p.circle(250, 380, 43, light)
    eyes(p, 250, 395, 28, 18)


def plan_centipede(p, c, feats):
    dark, main, light, acc = c
    pts = [(250 + math.sin(i * 0.7) * 45, 40 + i * 30) for i in range(14)]
    for i, (x, y) in enumerate(pts[:-1]):
        for s in (-1, 1):
            p.line([(x, y), (x + s * 75, y + 15)], acc, 8)
    p.tube(pts, 34, 46, dark, main)
    x, y = pts[-1]
    for s in (-1, 1):
        p.poly([(x + s * 20, y + 20), (x + s * 45, y + 70), (x + s * 10, y + 45)], acc)
    eyes(p, x, y + 5, 20, 12)


def plan_spider(p, c, feats):
    dark, main, light, acc = c
    for s in (-1, 1):
        for i in range(4):
            a = -0.9 + i * 0.6
            x0, y0 = 250 + s * 50, 300
            x1, y1 = x0 + s * 150 * math.cos(a), y0 + 150 * math.sin(a)
            x2, y2 = x1 + s * 60, y1 + 70 * (1 if a > 0 else -0.5)
            p.line([(x0, y0), (x1, y1), (x2, y2)], dark, 16)
    p.circle(250, 180, 110, dark)
    p.circle(250, 180, 96, main)
    p.poly(star_pts(250, 180, 45, 20, 4), acc)
    p.circle(250, 330, 75, dark)
    p.circle(250, 330, 64, light)
    for s in (-1, 1):
        p.ell(250 + s * 22, 400, 10, 28, acc)
    eyes(p, 250, 350, 24, 14)
    eyes(p, 250, 320, 14, 8, glint=False)


def plan_reptile(p, c, feats):
    dark, main, light, acc = c
    feats = set(feats)
    p.tube([(250 + math.sin(i * 0.5) * 30, 30 + i * 22) for i in range(9)], 12, 48, dark, main)
    for s in (-1, 1):
        for y in (200, 330):
            p.ell(250 + s * 120, y, 50, 24, dark, rot=s * 0.5)
            p.circle(250 + s * 160, y + 15, 18, dark)
    p.ell(250, 270, 92, 145, dark)
    p.ell(250, 270, 78, 130, main)
    if "spots" in feats:
        spots(p, 250, 260, 70, 110, acc, n=9, seed=11)
    if "gills" in feats:
        for s in (-1, 1):
            for i in range(3):
                p.ell(250 + s * 85, 370 + i * 16, 30, 8, acc, rot=s * 0.6)
    p.ell(250, 400, 68, 75, dark)
    p.ell(250, 400, 57, 64, main)
    p.ell(250, 430, 40, 30, light)
    eyes(p, 250, 395, 40, 20)


def plan_turtle(p, c, feats):
    dark, main, light, acc = c
    p.poly([(250, 70), (230, 130), (270, 130)], light)
    for s in (-1, 1):
        for y in (150, 360):
            p.ell(250 + s * 145, y, 55, 30, light, rot=s * (0.6 if y < 200 else -0.6))
    p.circle(250, 400, 62, shade(light, 0.8))
    p.circle(250, 400, 52, light)
    eyes(p, 250, 415, 30, 16)
    p.circle(250, 250, 165, acc)
    p.circle(250, 250, 150, dark)
    p.circle(250, 250, 130, main)
    for a in range(6):
        t = a / 6 * 2 * math.pi
        p.poly(star_pts(250 + math.cos(t) * 80, 250 + math.sin(t) * 80, 34, 30, 6), shade(main, 0.85))
    p.poly(star_pts(250, 250, 42, 38, 6), shade(main, 0.85))


def plan_crab(p, c, feats):
    dark, main, light, acc = c
    for s in (-1, 1):
        for i in range(3):
            y = 180 + i * 50
            p.line([(250 + s * 100, y), (250 + s * 190, y - 25), (250 + s * 220, y + 25)], dark, 18)
        p.line([(250 + s * 80, 320), (250 + s * 140, 390)], dark, 22)
        p.ell(250 + s * 155, 420, 52, 40, dark, rot=s * 0.6)
        p.ell(250 + s * 155, 420, 42, 30, main, rot=s * 0.6)
    p.ell(250, 260, 145, 110, dark)
    p.ell(250, 260, 128, 94, main)
    spots(p, 250, 250, 100, 70, light, n=6, seed=7, rmin=10, rmax=22)
    for s in (-1, 1):
        p.line([(250 + s * 30, 330), (250 + s * 40, 370)], dark, 8)
    eyes(p, 250, 372, 40, 18)


def plan_squid(p, c, feats):
    dark, main, light, acc = c
    for i in range(8):
        x = 140 + i * 31
        p.line([(x, 330), (x + math.sin(i) * 20, 400), (x - math.sin(i) * 25, 480)], dark, 18)
        p.line([(x, 330), (x + math.sin(i) * 20, 400)], main, 10)
    for s in (-1, 1):
        p.poly([(250, 40), (250 + s * 110, 110), (250 + s * 40, 140)], dark)
    p.ell(250, 210, 95, 160, dark)
    p.ell(250, 210, 80, 145, main)
    spots(p, 250, 180, 60, 100, acc, n=7, seed=9, rmin=6, rmax=12)
    eyes(p, 250, 320, 45, 24)


def plan_jelly(p, c, feats):
    dark, main, light, acc = c
    rnd = random.Random(2)
    for i in range(10):
        a = i / 10 * 2 * math.pi
        p.line([(250 + math.cos(a) * 100, 250 + math.sin(a) * 100), (250 + math.cos(a + 0.3) * 200, 250 + math.sin(a + 0.3) * 200),
                (250 + math.cos(a + 0.1) * 235, 250 + math.sin(a + 0.1) * 235)], shade(light, 1.0)[:3] + (200,), 10)
    p.circle(250, 250, 150, dark)
    p.circle(250, 250, 132, main)
    p.circle(250, 230, 80, light)
    for _ in range(6):
        p.circle(250 + rnd.uniform(-70, 70), 230 + rnd.uniform(-60, 60), rnd.uniform(6, 14), acc)
    eyes(p, 250, 320, 45, 22)


def plan_worm(p, c, feats):
    dark, main, light, acc = c
    feats = set(feats)
    pts = [(250 + math.sin(i * 0.55) * 70, 40 + i * 28) for i in range(14)]
    if "glow" in feats:
        for x, y in pts:
            p.circle(x, y, 64, acc[:3] + (60,))
    p.tube(pts, 30, 64, dark, main)
    for i in range(2, 12, 2):
        x, y = pts[i]
        p.ell(x, y, 40 + i * 2, 8, shade(main, 0.85))
    x, y = pts[-1]
    if "eyestalks" in feats:
        for s in (-1, 1):
            p.line([(x + s * 20, y), (x + s * 50, y + 70)], dark, 10)
            p.circle(x + s * 50, y + 75, 18, (0, 0, 0, 255))
            p.circle(x + s * 46, y + 70, 6, (255, 255, 255, 255))
    else:
        eyes(p, x, y + 15, 30, 17)


def plan_snake(p, c, feats):
    dark, main, light, acc = c
    pts = [(250 + math.sin(i * 0.6) * 120, 40 + i * 26) for i in range(15)]
    p.tube(pts, 18, 52, dark, main)
    if "spots" in set(feats):
        for i in range(1, 13, 2):
            x, y = pts[i]
            p.circle(x, y, 14 + i, shade(main, 0.7))
    x, y = pts[-1]
    p.ell(x, y + 25, 62, 70, dark)
    p.ell(x, y + 25, 50, 58, main)
    p.poly([(x - 20, y + 85), (x + 20, y + 85), (x, y + 105)], acc)
    eyes(p, x, y + 30, 32, 16)


def plan_blob(p, c, feats, r=170):
    dark, main, light, acc = c
    feats = set(feats)
    rnd = random.Random(4)
    if "fluffy" in feats:
        for i in range(12):
            a = i / 12 * 2 * math.pi
            p.circle(250 + math.cos(a) * r * 0.8, 250 + math.sin(a) * r * 0.8, r * 0.38, dark)
        for i in range(12):
            a = i / 12 * 2 * math.pi
            p.circle(250 + math.cos(a) * r * 0.75, 250 + math.sin(a) * r * 0.75, r * 0.3, main)
    p.circle(250, 250, r, dark)
    p.circle(250, 250, r * 0.88, main)
    p.circle(230, 210, r * 0.45, light)
    if "stars" in feats:
        stars(p, 250, 250, r, r, n=12)
    if "mouth" in feats:
        p.ell(250, 360, 90, 55, (20, 10, 25, 255))
        for i in range(6):
            p.poly([(180 + i * 28, 315), (205 + i * 28, 315), (192 + i * 28, 345)], (255, 255, 255, 255))
    eyes(p, 250, 290, 55, 30)


def plan_golem(p, c, feats):
    dark, main, light, acc = c
    feats = set(feats)
    for s in (-1, 1):
        p.poly([(250 + s * 120, 150), (250 + s * 230, 210), (250 + s * 215, 330), (250 + s * 120, 330)], dark)
        p.poly([(250 + s * 130, 165), (250 + s * 215, 215), (250 + s * 200, 315), (250 + s * 130, 315)], main)
    body = [(130, 110), (370, 110), (410, 260), (360, 420), (140, 420), (90, 260)]
    p.poly(body, dark)
    p.poly([(250 + (x - 250) * 0.87, 265 + (y - 265) * 0.87) for x, y in body], main)
    p.line([(200, 160), (230, 230), (210, 290)], dark, 7)
    p.line([(310, 180), (290, 250)], dark, 7)
    if "crystals" in feats:
        for x, y, h in ((180, 150, 70), (300, 140, 90), (340, 230, 60), (160, 260, 55)):
            p.poly([(x - 18, y + 20), (x, y - h), (x + 18, y + 20)], acc)
            p.poly([(x - 6, y + 10), (x, y - h * 0.7), (x + 4, y + 10)], (255, 255, 255, 160))
    if "moss" in feats:
        spots(p, 250, 230, 150, 120, acc[:3] + (255,), n=10, seed=13, rmin=14, rmax=28)
    if "horns" in feats:
        for s in (-1, 1):
            p.poly([(250 + s * 70, 130), (250 + s * 120, 30), (250 + s * 100, 140)], light)
    p.ell(250, 370, 70, 34, shade(dark, 0.7))
    eyes(p, 250, 330, 50, 24)


def plan_monster(p, c, feats):
    dark, main, light, acc = c
    feats = set(feats)
    for s in (-1, 1):
        for i in range(3):
            p.poly([(250 + s * (90 + i * 35), 120 + i * 30), (250 + s * (150 + i * 45), 40 + i * 50), (250 + s * (140 + i * 30), 160 + i * 40)], dark)
    p.circle(250, 260, 190, dark)
    p.circle(250, 260, 168, main)
    p.circle(250, 230, 95, light)
    if "moss" in feats:
        spots(p, 250, 230, 170, 150, acc, n=12, seed=17, rmin=12, rmax=26)
    if "stars" in feats:
        stars(p, 250, 250, 160, 160, n=16)
    if "lightning" in feats:
        for x in (170, 330):
            p.poly([(x, 120), (x + 40, 190), (x + 10, 195), (x + 45, 270), (x - 15, 180), (x + 15, 178)], acc)
    for s in (-1, 1):
        p.poly([(250 + s * 30, 405), (250 + s * 50, 470), (250 + s * 10, 420)], (255, 255, 255, 255))
    eyes(p, 250, 345, 62, 32)


def plan_dragon(p, c, feats):
    dark, main, light, acc = c
    feats = set(feats)
    p.tube([(250 + math.sin(i * 0.6) * 40, 20 + i * 22) for i in range(8)], 14, 50, dark, main)
    p.poly([(240, 10), (260, 10), (250, -10)], acc)
    if "wingless" not in feats:
        for s in (-1, 1):
            wing(p, s, 250 + s * 55, 215, 185, 105, 0.35, dark, shade(main, 1.15), kind="membrane")
    for s in (-1, 1):
        for y in (190, 330):
            p.ell(250 + s * 115, y, 45, 26, dark, rot=s * 0.6)
    p.ell(250, 260, 110, 150, dark)
    p.ell(250, 260, 95, 135, main)
    p.ell(250, 280, 45, 110, light)
    for i in range(5):
        p.poly([(240, 140 + i * 40), (260, 140 + i * 40), (250, 120 + i * 40)], acc)
    if "stars" in feats:
        stars(p, 250, 240, 90, 130, n=12)
    if "lightning" in feats:
        for s in (-1, 1):
            p.poly([(250 + s * 140, 150), (250 + s * 190, 210), (250 + s * 160, 215), (250 + s * 205, 285), (250 + s * 135, 205), (250 + s * 165, 202)], acc)
    heads = [(250, 410)] if "heads3" not in feats else [(150, 395), (250, 425), (350, 395)]
    for x, y in heads:
        p.line([(250, 360), (x, y - 30)], dark, 44)
        p.ell(x, y, 52, 62, dark)
        p.ell(x, y, 42, 52, main)
        for s in (-1, 1):
            p.poly([(x + s * 25, y - 40), (x + s * 50, y - 95), (x + s * 40, y - 30)], acc)
        p.ell(x, y + 38, 26, 20, light)
        eyes(p, x, y + 5, 24, 13)


def plan_griffin(p, c, feats):
    dark, main, light, acc = c
    p.line([(250, 170), (230, 110), (270, 70)], dark, 16)
    p.circle(270, 60, 22, dark)
    for s in (-1, 1):
        wing(p, s, 250 + s * 60, 230, 180, 76, 0.35, dark, acc)
    p.ell(250, 260, 120, 140, dark)
    p.ell(250, 260, 104, 124, main)
    p.circle(250, 365, 72, shade(acc, 0.85))
    p.circle(250, 365, 60, acc)
    p.poly([(225, 405), (275, 405), (250, 455)], hexc("#f0b030"))
    eyes(p, 250, 372, 34, 18)


def plan_horse(p, c, feats):
    dark, main, light, acc = c
    p.line([(250, 150), (240, 90), (265, 40)], acc, 34)
    for s in (-1, 1):
        wing(p, s, 250 + s * 60, 230, 180, 80, 0.35, dark, light)
    p.ell(250, 250, 105, 150, dark)
    p.ell(250, 250, 90, 135, main)
    p.ell(250, 395, 55, 90, dark)
    p.ell(250, 395, 45, 80, main)
    p.ell(250, 290, 22, 120, acc)
    p.ell(250, 455, 30, 22, shade(main, 0.9))
    eyes(p, 250, 395, 34, 16)


def plan_alien(p, c, feats):
    dark, main, light, acc = c
    for s in (-1, 1):
        p.line([(250 + s * 40, 320), (250 + s * 80, 430)], dark, 10)
        p.circle(250 + s * 80, 435, 18, light)
        p.line([(250 + s * 100, 200), (250 + s * 190, 250)], dark, 22)
        p.circle(250 + s * 195, 255, 24, main)
    p.ell(250, 200, 90, 120, dark)
    p.ell(250, 200, 78, 108, main)
    p.ell(250, 320, 120, 95, dark)
    p.ell(250, 320, 106, 82, main)
    p.ell(250 - 50, 335, 34, 22, (0, 0, 0, 255), rot=0.4)
    p.ell(250 + 50, 335, 34, 22, (0, 0, 0, 255), rot=-0.4)
    p.circle(250 - 60, 328, 7, (255, 255, 255, 255))
    p.circle(250 + 40, 328, 7, (255, 255, 255, 255))


PLANS = {
    "mammal": plan_mammal, "glider": plan_glider, "bird": plan_bird, "bat": plan_bat, "fish": plan_fish, "ray": plan_ray,
    "whale": plan_whale, "insect": plan_insect, "centipede": plan_centipede, "spider": plan_spider, "reptile": plan_reptile,
    "turtle": plan_turtle, "crab": plan_crab, "squid": plan_squid, "jelly": plan_jelly, "worm": plan_worm, "snake": plan_snake,
    "blob": plan_blob, "golem": plan_golem, "monster": plan_monster, "dragon": plan_dragon, "griffin": plan_griffin,
    "horse": plan_horse, "alien": plan_alien,
}


def draw_animal(a):
    p = Pen()
    colors = [hexc(x) for x in a["colors"]]
    PLANS[a["plan"]](p, colors, a.get("features", []))
    return p.img.resize((500, 500), Image.LANCZOS)


# ---------- foods ----------

F = 300 * K


def draw_food_shape(f):
    p = Pen(F)
    dark, main, light = [hexc(x) for x in f["colors"]]
    s, cx = f["shape"], 150
    k = 1.0
    if s == "berry":
        for x, y in ((115, 165), (185, 165), (150, 110), (150, 190)):
            p.circle(x, y, 48, dark)
            p.circle(x, y, 40, main)
            p.circle(x - 14, y - 14, 10, light)
        p.ell(150, 72, 30, 14, hexc("#3a8a2a"))
    elif s == "leaves":
        for a in range(5):
            t = a / 5 * 2 * math.pi
            p.ell(150 + math.cos(t) * 45, 150 + math.sin(t) * 45, 45, 32, dark, rot=t)
            p.ell(150 + math.cos(t) * 45, 150 + math.sin(t) * 45, 37, 25, main, rot=t)
        p.circle(150, 150, 22, light)
    elif s == "cattail":
        p.line([(150, 260), (150, 60)], light, 14)
        p.ell(150, 140, 34, 80, dark)
        p.ell(150, 140, 26, 70, main)
    elif s == "mushroom":
        p.ell(150, 205, 32, 50, light)
        p.ell(150, 135, 100, 70, dark)
        p.ell(150, 128, 88, 58, main)
        for x, y in ((115, 115), (175, 105), (150, 150)):
            p.circle(x, y, 13, light)
    elif s == "bug":
        p.circle(150, 165, 70, main[:3] + (90,))
        p.ell(150, 165, 34, 48, main)
        p.circle(150, 115, 26, dark)
        for side in (-1, 1):
            p.ell(150 + side * 45, 145, 40, 20, light[:3] + (200,), rot=side * 0.4)
    elif s == "flower":
        for a in range(8):
            t = a / 8 * 2 * math.pi
            p.ell(150 + math.cos(t) * 62, 150 + math.sin(t) * 62, 52, 30, dark, rot=t)
            p.ell(150 + math.cos(t) * 62, 150 + math.sin(t) * 62, 44, 23, main, rot=t)
        p.circle(150, 150, 36, light)
    elif s == "egg":
        p.ell(150, 155, 85, 110, light)
        p.ell(150, 155, 76, 100, main)
        spots(p, 150, 155, 70, 90, light, n=7, seed=21, rmin=6, rmax=12)
    elif s == "grub":
        pts = [(80 + i * 22, 150 + math.sin(i * 0.8) * 25) for i in range(7)]
        p.tube(pts, 34, 40, light, main)
        eyes(p, pts[-1][0], pts[-1][1], 12, 7)
    elif s == "root":
        p.line([(80, 80), (150, 150), (230, 230)], dark, 46)
        p.line([(80, 80), (150, 150), (230, 230)], main, 30)
        p.line([(150, 150), (110, 230)], main, 20)
        p.line([(150, 150), (230, 100)], main, 18)
    elif s == "lump":
        p.circle(150, 150, 95, dark)
        p.circle(150, 150, 80, main)
        spots(p, 150, 150, 80, 80, light, n=9, seed=23, rmin=6, rmax=14)
    elif s == "crystal":
        for x, h in ((105, 120), (150, 170), (195, 110)):
            p.poly([(x - 30, 240), (x - 30, 240 - h * 0.7), (x, 240 - h), (x + 30, 240 - h * 0.7), (x + 30, 240)], dark)
            p.poly([(x - 20, 232), (x - 20, 240 - h * 0.65), (x, 240 - h + 14), (x + 20, 240 - h * 0.65), (x + 20, 232)], main)
            p.poly([(x - 8, 230), (x - 8, 240 - h * 0.6), (x, 240 - h + 30), (x, 230)], light)
    elif s == "bone":
        p.line([(90, 90), (210, 210)], main, 46)
        for x, y in ((80, 105), (105, 80), (195, 220), (220, 195)):
            p.circle(x, y, 32, main)
        p.line([(100, 100), (200, 200)], light, 18)
    elif s == "nugget":
        pts = [(80, 160), (110, 90), (190, 80), (230, 150), (200, 220), (110, 225)]
        p.poly(pts, dark)
        p.poly([(150 + (x - 150) * 0.82, 152 + (y - 152) * 0.82) for x, y in pts], main)
        p.poly([(120, 120), (170, 105), (150, 150)], light)
    elif s == "seed":
        p.ell(150, 150, 60, 100, dark, rot=0.5)
        p.ell(150, 150, 50, 88, main, rot=0.5)
        p.ell(132, 125, 16, 40, light, rot=0.5)
    elif s == "feather":
        p.line([(90, 240), (210, 60)], dark, 10)
        p.ell(160, 135, 50, 110, light, rot=0.6)
        p.ell(160, 135, 42, 100, main, rot=0.6)
        p.line([(100, 225), (205, 70)], dark, 6)
    elif s == "rainbow":
        cols = [hexc("#e04040"), hexc("#f08a30"), hexc("#f0d030"), hexc("#50c050"), hexc("#40a0f0"), hexc("#8050d0")]
        for i, col in enumerate(cols):
            p.circle(150, 150, 100 - i * 14, col)
        p.circle(125, 120, 16, (255, 255, 255, 200))
    elif s == "cotton":
        for x, y in ((110, 150), (190, 150), (150, 110), (150, 190), (150, 150)):
            p.circle(x, y, 55, main)
        for x, y in ((120, 130), (170, 120)):
            p.circle(x, y, 25, light)
        p.line([(150, 200), (150, 285)], hexc("#f0e0c0"), 14)
    elif s == "orb":
        p.circle(150, 150, 100, main[:3] + (90,))
        p.circle(150, 150, 75, dark)
        p.circle(150, 150, 64, main)
        p.poly([(150, 85), (175, 150), (152, 150), (165, 215), (125, 140), (148, 140)], light)
    elif s == "sparkle":
        p.poly(star_pts(150, 150, 110, 30, 4), dark)
        p.poly(star_pts(150, 150, 85, 22, 4), main)
        p.poly(star_pts(100, 95, 35, 10, 4), light)
        p.poly(star_pts(205, 205, 30, 9, 4), light)
    elif s == "wedge":
        p.poly([(50, 220), (250, 220), (250, 90)], dark)
        p.poly([(70, 210), (240, 210), (240, 105)], main)
        for x, y, r in ((170, 185, 14), (215, 160, 10), (205, 195, 8)):
            p.circle(x, y, r, light)
    elif s == "star":
        p.poly(star_pts(150, 155, 115, 50), dark)
        p.poly(star_pts(150, 155, 95, 40), main)
        p.poly(star_pts(150, 155, 45, 20), light)
    elif s == "candy":
        for side in (-1, 1):
            p.poly([(150 + side * 50, 150), (150 + side * 120, 100), (150 + side * 120, 200)], dark)
        p.circle(150, 150, 65, dark)
        p.circle(150, 150, 54, main)
        p.line([(110, 125), (190, 175)], light, 14)
    elif s == "rock":
        pts = [(70, 150), (100, 80), (190, 70), (240, 140), (215, 225), (110, 230)]
        p.poly(pts, dark)
        p.poly([(150 + (x - 150) * 0.84, 150 + (y - 150) * 0.84) for x, y in pts], main)
        spots(p, 150, 150, 80, 70, light, n=6, seed=25, rmin=8, rmax=16)
    elif s == "planet":
        p.circle(150, 150, 80, dark)
        p.circle(150, 150, 70, main)
        p.ell(150, 150, 135, 30, light, rot=-0.35)
        p.ell(150, 150, 120, 20, (0, 0, 0, 0), rot=-0.35)
        p.circle(150, 150, 60, main)
        p.ell(130, 125, 25, 14, shade(main, 1.3))
    else:
        raise SystemExit(f"unknown food shape {s}")
    return p.img


def outlined(shape, col, width):
    alpha = shape.split()[3]
    grown = alpha.filter(ImageFilter.MaxFilter(width * 2 + 1))
    base = Image.new("RGBA", shape.size, col)
    out = Image.new("RGBA", shape.size, (0, 0, 0, 0))
    out.paste(base, (0, 0), grown)
    out.alpha_composite(shape)
    return out


def draw_food(f):
    shape = draw_food_shape(f).resize((300, 300), Image.LANCZOS)
    biome = DATA["biomes"][f["biome"]]
    normal = outlined(shape, hexc(biome["foodOutline"]), 9)
    edible = outlined(shape, hexc("#4ae05e"), 9)
    return normal, edible


def save(img, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "WEBP", quality=92, method=6)


def main():
    only = None
    sheet = None
    args = sys.argv[1:]
    if "--only" in args:
        only = set(args[args.index("--only") + 1].split(","))
    if "--sheet" in args:
        sheet = args[args.index("--sheet") + 1]
    tiles = []
    for a in DATA["animals"]:
        if only and a["slug"] not in only:
            continue
        img = draw_animal(a)
        d = OUT / "animals" / a["biome"] / a["slug"]
        save(img, d / "body.webp")
        save(img, d / f"{a['slug']}.ui.webp")
        tiles.append((a["slug"], img))
    for f in DATA["foods"]:
        if only and f["slug"] not in only:
            continue
        normal, edible = draw_food(f)
        d = OUT / "foods" / f["slug"]
        save(normal, d / f"{f['slug']}.webp")
        save(edible, d / "edible.webp")
        tiles.append((f["slug"], normal.resize((500, 500))))
    print(f"drew {len(tiles)} sprites")
    if sheet:
        cols = 10
        rows = math.ceil(len(tiles) / cols)
        s = 160
        out = Image.new("RGBA", (cols * s, rows * s), (60, 140, 70, 255))
        for i, (_, img) in enumerate(tiles):
            out.alpha_composite(img.resize((s, s), Image.LANCZOS), ((i % cols) * s, (i // cols) * s))
        out.save(sheet)


if __name__ == "__main__":
    main()
