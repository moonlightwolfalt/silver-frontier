#!/usr/bin/env python3
"""Download Mope.io assets from s3.mope.io, sorted into categories.

Sources of asset URLs:
  1. mope-dump/manifest.json (produced by `bun run fetch-mope.ts`)
  2. the bucket listing at https://s3.mope.io/ (works only if listing is public)

Usage: python3 fetch_assets.py [--manifest mope-dump/manifest.json] [--out assets]
"""
import argparse
import json
import re
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

S3 = "https://s3.mope.io"
UA = {"User-Agent": "Mozilla/5.0 (compatible; asset-fetcher)"}

# First matching category wins, so more specific ones come first.
CATEGORIES = {
    "Shop Skins": r"skin|shop|store|cosmetic|hat|costume",
    "Biome Terrains": r"terrain|ground|tile|floor|texture",
    "Biomes": r"biome|arctic|desert|ocean|land|sea|lava|volcano|jungle|forest|river|mud",
    "Foods": r"food|berry|berries|fruit|meat|mushroom|plant|seed|fish|carrot|apple|banana|coconut|kelp|algae",
    "Animals": r"animal|mouse|rabbit|deer|fox|wolf|bear|lion|shark|whale|dragon|croc|hippo|elephant|rhino|"
               r"zebra|cheetah|eagle|owl|bat|squid|crab|turtle|snake|kraken|trex|yeti|monkey|gorilla",
    "Game Object Assets": r"object|rock|tree|bush|hole|pond|lake|mud|wall|egg|nest|crate|chest|cloud|particle|effect",
    "UI": r"ui|icon|button|menu|hud|logo|badge|bar|panel|cursor|xp|flag|font",
}
RULES = [(name, re.compile(rx, re.I)) for name, rx in CATEGORIES.items()]
ASSET_RE = re.compile(r"\.(png|jpe?g|webp|svg|gif|json|mp3|ogg|wav)$", re.I)


def get(url: str) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
        return r.read()


def list_bucket() -> list[str]:
    """Walk an S3 ListObjectsV2 listing; returns [] if the bucket isn't listable."""
    urls, token = [], None
    while True:
        q = {"list-type": "2"}
        if token:
            q["continuation-token"] = token
        try:
            root = ET.fromstring(get(f"{S3}/?{urllib.parse.urlencode(q)}"))
        except Exception as e:
            print(f"bucket listing unavailable: {e}", file=sys.stderr)
            return urls
        ns = {"s": root.tag.split("}")[0].strip("{")} if root.tag.startswith("{") else {}
        p = "s:" if ns else ""
        urls += [f"{S3}/{urllib.parse.quote(k.text)}" for k in root.findall(f".//{p}Key", ns)]
        nxt = root.find(f"{p}NextContinuationToken", ns)
        if nxt is None:
            return urls
        token = nxt.text


def categorize(url: str) -> str:
    path = urllib.parse.unquote(urllib.parse.urlparse(url).path)
    for name, rx in RULES:
        if rx.search(path):
            return name
    return "Uncategorized"


def download(job: tuple[str, Path]) -> tuple[str, bool]:
    url, dest = job
    if dest.exists():
        return url, True
    try:
        data = get(url)
    except Exception as e:
        print(f"fail {url}: {e}", file=sys.stderr)
        return url, False
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    return url, True


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", default="mope-dump/manifest.json")
    ap.add_argument("--out", default="assets")
    args = ap.parse_args()

    urls: set[str] = set(list_bucket())
    try:
        manifest = json.loads(Path(args.manifest).read_text())
        urls |= {u for u in manifest["assets"] if urllib.parse.urlparse(u).netloc.endswith("mope.io")}
    except FileNotFoundError:
        print(f"no manifest at {args.manifest}; run `bun run fetch-mope.ts` first", file=sys.stderr)
    urls = {u for u in urls if ASSET_RE.search(urllib.parse.urlparse(u).path)}
    if not urls:
        sys.exit("no asset URLs found")

    out = Path(args.out)
    jobs, index = [], {}
    for url in sorted(urls):
        cat = categorize(url)
        name = Path(urllib.parse.unquote(urllib.parse.urlparse(url).path)).name
        dest = out / cat / name
        if dest in (j[1] for j in jobs):  # same filename from different dirs
            dest = out / cat / (urllib.parse.urlparse(url).path.strip("/").replace("/", "_"))
        jobs.append((url, dest))
        index.setdefault(cat, []).append({"file": f"{cat}/{dest.name}", "source": url})

    with ThreadPoolExecutor(8) as pool:
        ok = dict(pool.map(download, jobs))
    for entries in index.values():
        entries[:] = [e for e in entries if ok.get(e["source"])]

    out.mkdir(parents=True, exist_ok=True)
    (out / "index.json").write_text(json.dumps(index, indent=2))
    for cat, entries in sorted(index.items()):
        print(f"{cat}: {len(entries)}")


if __name__ == "__main__":
    main()
