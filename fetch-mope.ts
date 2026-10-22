// Usage: bun run fetch-mope.ts [outDir]
// Downloads the mope.io front page plus every script/stylesheet it references,
// then scans them for asset URLs (s3.mope.io and relative image/audio paths)
// and writes them to <outDir>/manifest.json for fetch_assets.py.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const BASE = "https://mope.io";
const OUT = process.argv[2] ?? "mope-dump";
const ASSET_EXT = "png|jpg|jpeg|webp|svg|gif|json|mp3|ogg|wav";
const UA = { "User-Agent": "Mozilla/5.0 (compatible; asset-fetcher)" };

const get = async (url: string) => {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res;
};

async function save(url: string, body: string) {
  const u = new URL(url);
  const rel = u.pathname.endsWith("/") ? u.pathname + "index.html" : u.pathname;
  const file = join(OUT, "site", u.host, rel);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, body);
}

const html = await (await get(BASE)).text();
await save(BASE + "/", html);

const refs = new Set<string>();
for (const m of html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css)[^"']*)["']/gi)) {
  refs.add(new URL(m[1], BASE).href);
}

const sources: Record<string, string> = { [BASE + "/"]: html };
for (const url of refs) {
  try {
    sources[url] = await (await get(url)).text();
    await save(url, sources[url]);
    console.log("fetched", url);
  } catch (e) {
    console.warn("skip", String(e));
  }
}

// Pull asset URLs out of every fetched source.
const found = new Set<string>();
const absolute = new RegExp(`https?://[\\w.-]*mope\\.io/[^\\s"'\`)\\\\]+\\.(?:${ASSET_EXT})`, "gi");
const relative = new RegExp(`["'\`]((?:\\.{0,2}/)?[\\w./@%-]+\\.(?:${ASSET_EXT}))(?:\\?[^"'\`]*)?["'\`]`, "gi");
for (const [origin, text] of Object.entries(sources)) {
  for (const m of text.matchAll(absolute)) found.add(m[0]);
  for (const m of text.matchAll(relative)) {
    try { found.add(new URL(m[1], origin).href); } catch {}
  }
}

const manifest = {
  generatedAt: new Date().toISOString(),
  base: BASE,
  sources: Object.keys(sources),
  assets: [...found].sort(),
};
await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`${manifest.assets.length} asset URLs -> ${join(OUT, "manifest.json")}`);
