// Usage: node server.js   (PORT=3000 by default; behind a proxy set NODE_USE_ENV_PROXY=1)
// Generates every asset category from mope.io / s3.mope.io (see asset-catalog.js), starts the
// local sandbox game server for the LOCALTEST region (game-server.js, GAME_PORT=8443), and serves:
//   /                       the fetched mope.io client (mope-dump/site/mope.io)
//   /assets/<path>          game textures: generated copy first, else mope.io (cached)
//   /s3/<path>              s3.mope.io files (skins, translations): generated copy first, else
//                           s3.mope.io (cached); the patched client points s3PublicUrl here
//   /gallery                gallery of every category
//   /api/categories         { category: count }
//   /api/assets/:category   [{ file, source }]
//   /dl/<cat>/<file>        the generated category files (assets/)
//   POST /api/refresh       re-run the generator
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATEGORIES, generate as generateAssets } from "./asset-catalog.js";

const PORT = process.env.PORT || 3000;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(ROOT, "assets");
const DUMP = path.join(ROOT, "mope-dump/site");
const SITE = path.join(DUMP, "mope.io");
const TYPES = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".gif": "image/gif", ".json": "application/json",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".html": "text/html",
  ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2",
};
const typeOf = (file) => TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";

let running = null;
function generate() {
  running ??= generateAssets({ clientDir: SITE, outDir: ASSETS })
    .then(() => (bySource = null))
    .finally(() => (running = null));
  return running;
}

const readIndex = () => {
  try { return JSON.parse(fs.readFileSync(path.join(ASSETS, "index.json"), "utf8")); }
  catch { return {}; }
};

// source URL -> generated file, so the game's own requests are served from assets/
let bySource = null;
function generatedFile(source) {
  if (!bySource) {
    bySource = new Map();
    for (const list of Object.values(readIndex())) for (const e of list) bySource.set(e.source, path.join(ASSETS, e.file));
  }
  return bySource.get(source);
}

const json = (res, code, body) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const send = (res, file, data) => {
  res.writeHead(200, { "Content-Type": typeOf(file) });
  res.end(data);
};

// Serves a file from the local cache, or fetches it from upstream and caches it. mope.io answers
// unknown paths with its index.html, so an HTML reply to a non-HTML path counts as missing.
async function serveCached(res, cacheRoot, rel, upstream) {
  const file = path.normalize(path.join(cacheRoot, rel));
  if (!file.startsWith(cacheRoot + path.sep)) { res.writeHead(403); return res.end(); }
  try { return send(res, file, await fs.promises.readFile(file)); } catch {}
  try {
    const up = await fetch(upstream, { headers: { "User-Agent": "Mozilla/5.0 (compatible; asset-fetcher)" } });
    const type = up.headers.get("content-type") || "";
    if (up.ok && !(type.includes("text/html") && !file.endsWith(".html"))) {
      const data = Buffer.from(await up.arrayBuffer());
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, data);
      return send(res, file, data);
    }
  } catch {}
  res.writeHead(404);
  res.end("not found");
}

const PAGE = `<!doctype html><meta charset=utf-8><title>Mope assets</title>
<style>body{font:14px sans-serif;margin:16px}img{max-width:96px;max-height:96px;background:#ddd;margin:4px}</style>
<body><h1>Mope assets</h1><div id=o></div><script>
fetch('/api/assets-all').then(r=>r.json()).then(d=>{
  o.innerHTML=Object.entries(d).map(([c,l])=>'<h2>'+c+' ('+l.length+')</h2>'+
    l.map(e=>/\\.(png|jpe?g|webp|svg|gif)$/i.test(e.file)?'<img loading=lazy title="'+e.file+'" src="/dl/'+encodeURI(e.file)+'">':'<a href="/dl/'+encodeURI(e.file)+'">'+e.file+'</a> ').join('')).join('');
});</script>`;

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = decodeURIComponent(url.pathname);

  if (p === "/gallery") { res.writeHead(200, { "Content-Type": TYPES[".html"] }); return res.end(PAGE); }
  if (p === "/api/assets-all") return json(res, 200, readIndex());
  if (p === "/api/categories") {
    const idx = readIndex();
    return json(res, 200, Object.fromEntries(CATEGORIES.map((c) => [c, (idx[c] || []).length])));
  }
  if (p.startsWith("/api/assets/")) return json(res, 200, readIndex()[p.slice("/api/assets/".length)] || []);
  if (p === "/api/refresh" && req.method === "POST") {
    try { await generate(); return json(res, 200, { ok: true }); }
    catch (e) { return json(res, 500, { error: String(e.message) }); }
  }
  if (p.startsWith("/dl/")) {
    const file = path.normalize(path.join(ASSETS, p.slice("/dl/".length)));
    if (!file.startsWith(ASSETS + path.sep)) { res.writeHead(403); return res.end(); }
    return fs.readFile(file, (err, data) => (err ? (res.writeHead(404), res.end("not found")) : send(res, file, data)));
  }
  if (p.startsWith("/s3/")) {
    const source = `https://s3.mope.io/${p.slice("/s3/".length)}`;
    const local = generatedFile(source);
    if (local && fs.existsSync(local)) return send(res, local, fs.readFileSync(local));
    return serveCached(res, path.join(DUMP, "s3.mope.io"), p.slice("/s3/".length), source + url.search);
  }
  if (p.startsWith("/assets/")) {
    const local = generatedFile(`https://mope.io${p}`);
    if (local && fs.existsSync(local)) return send(res, local, fs.readFileSync(local));
  }
  if (p === "/") {
    return fs.readFile(path.join(SITE, "index.html"), (err, data) =>
      err ? (res.writeHead(404), res.end("mope.io client not fetched yet; run: bun run fetch-mope.ts")) : send(res, "index.html", data));
  }
  return serveCached(res, SITE, p.slice(1), new URL(p + url.search, "https://mope.io"));
}).listen(PORT, async () => {
  console.log(`http://localhost:${PORT}`);
  if (!fs.existsSync(path.join(SITE, "index.html"))) return console.log("client not fetched yet; run: bun run setup");
  await import("./game-server.js");
  if (!fs.existsSync(path.join(ASSETS, "index.json"))) {
    console.log("no assets yet, generating ...");
    try { await generate(); } catch (e) { console.error(e.message); }
  }
});
