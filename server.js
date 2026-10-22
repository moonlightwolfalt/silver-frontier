// Usage: node server.js   (PORT=3000 by default)
// Runs fetch_assets.py to generate the asset folders, then serves them:
//   /                       the fetched mope.io index.html (mope-dump/site/mope.io), and
//                           any script/css saved next to it, at their original paths; files
//                           not fetched yet are pulled from mope.io once and cached there
//   /gallery                gallery of every category
//   /api/categories         { category: count }
//   /api/assets/:category   [{ file, source }]
//   /dl/<cat>/<file>        the downloaded category files (assets/)
//   POST /api/refresh       re-run the Python fetcher
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PORT = process.env.PORT || 3000;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(ROOT, "assets");
const SITE = path.join(ROOT, "mope-dump/site/mope.io");
const CATEGORIES = ["Animals", "UI", "Shop Skins", "Foods", "Game Object Assets", "Biomes", "Biome Terrains"];
const TYPES = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".gif": "image/gif", ".json": "application/json",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".html": "text/html",
  ".js": "text/javascript", ".css": "text/css",
};

let running = null;
function generate() {
  if (running) return running;
  running = new Promise((resolve, reject) => {
    const p = spawn("python3", ["-I", path.join(ROOT, "fetch_assets.py"), "--manifest", path.join(ROOT, "mope-dump/manifest.json"), "--out", ASSETS], {
      stdio: "inherit",
    });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`fetch_assets.py exited ${code}`))));
  }).finally(() => (running = null));
  return running;
}

const readIndex = () => {
  try { return JSON.parse(fs.readFileSync(path.join(ASSETS, "index.json"), "utf8")); }
  catch { return {}; }
};

const json = (res, code, body) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

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
    const out = Object.fromEntries(CATEGORIES.map((c) => [c, (idx[c] || []).length]));
    return json(res, 200, out);
  }
  if (p.startsWith("/api/assets/")) {
    const cat = p.slice("/api/assets/".length);
    return json(res, 200, readIndex()[cat] || []);
  }
  if (p === "/api/refresh" && req.method === "POST") {
    try { await generate(); return json(res, 200, { ok: true }); }
    catch (e) { return json(res, 500, { error: String(e.message) }); }
  }
  if (p.startsWith("/dl/")) {
    const file = path.normalize(path.join(ASSETS, p.slice("/dl/".length)));
    if (!file.startsWith(ASSETS + path.sep)) { res.writeHead(403); return res.end(); }
    return fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream" });
      res.end(data);
    });
  }
  // Fall through to the fetched mope.io site files; "/" maps to index.html.
  const rel = p === "/" ? "index.html" : p.slice(1);
  const file = path.normalize(path.join(SITE, rel));
  if (!file.startsWith(SITE + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, async (err, data) => {
    if (err && p !== "/") {
      // Not fetched yet: pull it from mope.io once and keep a copy.
      try {
        const up = await fetch(new URL(p + url.search, "https://mope.io"), { headers: { "User-Agent": "Mozilla/5.0 (compatible; asset-fetcher)" } });
        if (up.ok) {
          data = Buffer.from(await up.arrayBuffer());
          if (!url.search) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, data);
          }
          err = null;
        }
      } catch {}
    }
    if (err) {
      res.writeHead(404);
      return res.end(p === "/" ? "mope.io index.html not fetched yet; run: bun run fetch-mope.ts" : "not found");
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream" });
    res.end(data);
  });
}).listen(PORT, async () => {
  console.log(`http://localhost:${PORT}`);
  if (!fs.existsSync(path.join(ASSETS, "index.json"))) {
    console.log("no assets yet, running fetch_assets.py ...");
    try { await generate(); } catch (e) { console.error(e.message); }
  }
});
