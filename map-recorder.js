// Records the real mope.io map. mope.io's server decides where every tree, lake, rock and food is,
// so the only way to copy its map is to watch what it sends. The bookmarklet below runs on
// mope.io in your own browser: it listens to the game connection, keeps every createEntity
// record (static objects and foods), shows a running count, and saves them to a file. Upload
// that file on /map-recorder and game-server.js decodes it (decodeCapture) into data/map.json.
//
// info comes from game-server.js recorderInfo(): the protocol numbers of the client we serve,
// which match mope.io's as long as mope-dump/ is a recent fetch.

// The game opens its socket as the page loads, before the bookmarklet runs, so it watches every
// message the page reads (MessageEvent.data) rather than wrapping new sockets. No // comments
// inside the code: it is joined onto one line.
export function recorderScript(info) {
  const code = `(() => {
  if (window.__sfMap) return window.__sfMap.show();
  const U = ${info.update}, C = ${info.createGroup}, NAMES = ${JSON.stringify(info.typeNames)};
  const SKIP = new Set(${JSON.stringify(info.skipTypes)});
  const recs = {};
  let msgs = 0, updates = 0;
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;z-index:2147483647;left:8px;bottom:8px;background:rgba(0,0,0,.82);color:#fff;font:13px/1.35 sans-serif;padding:8px 10px;border-radius:8px;max-width:280px";
  const txt = document.createElement("div");
  const save = document.createElement("button");
  const again = document.createElement("button");
  const sockets = new Set();
  const hide = document.createElement("button");
  save.textContent = "Save map file";
  again.textContent = "Reconnect";
  hide.textContent = "Hide";
  for (const b of [save, again, hide]) b.style.cssText = "margin:6px 6px 0 0;font:inherit;padding:4px 10px;border-radius:6px;border:0;background:#fff;color:#111";
  box.append(txt, save, again, hide);
  document.body.append(box);
  const draw = () => {
    const counts = {};
    for (const u of Object.values(recs)) { const t = NAMES[u[0]] || u[0]; counts[t] = (counts[t] || 0) + 1; }
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t, n]) => t + " " + n).join(", ");
    txt.textContent = !msgs ? "Map recorder on. Press Play, then explore the whole map." :
      !updates ? "Connected, but no map data seen yet (" + msgs + " messages). If this stays, the recorder needs updating." :
      !Object.keys(recs).length ? "Connected (" + msgs + " messages) but no map objects yet. Press Reconnect, then Try Again, so the server sends the map again." :
      "Recorded " + Object.keys(recs).length + " objects: " + top + ". Explore every biome, then save.";
  };
  setInterval(draw, 1000);
  draw();
  const scan = (d) => {
    if (d instanceof Blob) return d.arrayBuffer().then(scan);
    if (!(d instanceof ArrayBuffer)) return;
    msgs++;
    const v = new DataView(d), L = v.byteLength;
    if (!L || v.getUint8(0) !== U) return;
    updates++;
    let o = 1;
    try {
      while (o + 4 <= L) {
        const kind = v.getUint16(o, true), n = v.getUint16(o + 2, true);
        o += 4;
        for (let i = 0; i < n; i++) {
          let len = v.getUint8(o++);
          if (len === 255) { len = v.getUint16(o, true); o += 2; }
          if (o + len > L) return;
          if (kind === C && len >= 5) {
            const u = new Uint8Array(d, o, len);
            if (!SKIP.has(u[0])) recs[v.getUint16(o + 2, true)] = u.slice();
          }
          o += len;
        }
      }
    } catch (e) {}
  };
  const seen = new WeakSet();
  const desc = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data");
  Object.defineProperty(MessageEvent.prototype, "data", { ...desc, get() {
    const d = desc.get.call(this);
    if (this.target instanceof WebSocket && !seen.has(this)) { seen.add(this); sockets.add(this.target); try { scan(d); } catch (e) {} }
    return d;
  } });
  const b64 = (u) => { let s = ""; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); };
  save.onclick = () => {
    const out = { format: "silver-frontier-map-capture", version: 1, protocol: ${JSON.stringify(info.protocol)}, recordedAt: new Date().toISOString(),
      records: Object.fromEntries(Object.entries(recs).map(([id, u]) => [id, b64(u)])) };
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(out)], { type: "application/json" }));
    a.download = "mope-map.json";
    document.body.append(a);
    a.click();
    a.remove();
  };
  hide.onclick = () => (box.style.display = "none");
  again.onclick = () => { for (const ws of sockets) ws.close(); sockets.clear(); };
  window.__sfMap = { show: () => (box.style.display = "") };
})();`;
  // One line, so it can be pasted into a bookmark's address.
  return "javascript:" + code.replace(/\n\s*/g, " ");
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function recorderPage(info, status) {
  const bookmarklet = recorderScript(info);
  const current = status
    ? `Using a map recorded ${status.recordedAt ? esc(new Date(status.recordedAt).toUTCString()) : ""}: ${status.objects} objects and ${status.foods} foods.`
    : "Using the generated map.";
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Map recorder</title>
<style>
:root{--bg:#f4f6f3;--fg:#17211a;--muted:#55635a;--card:#fff;--line:#d6ddd7;--accent:#1f8a3b}
@media (prefers-color-scheme:dark){:root{--bg:#121714;--fg:#e6ece7;--muted:#9aa89e;--card:#1b221d;--line:#2c3630;--accent:#4cc46d}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:720px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}
p,li{color:var(--muted)}b{color:var(--fg)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:12px 0}
a.bm{display:inline-block;background:var(--accent);color:#fff;text-decoration:none;padding:8px 14px;border-radius:8px;font-weight:600}
textarea{width:100%;box-sizing:border-box;height:90px;font:12px ui-monospace,monospace;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:8px}
button{font:inherit;padding:7px 14px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg)}
#msg{white-space:pre-wrap}
</style>
<main>
<h1>Map recorder</h1>
<p>Copies the real mope.io map onto this server. ${esc(current)}</p>

<h2>1. Add the recorder bookmark</h2>
<div class=card>
<p><b>Computer:</b> drag this button to your bookmarks bar: <a class=bm href="${esc(bookmarklet)}">Mope map recorder</a></p>
<p><b>iPhone / iPad (Safari):</b> bookmark any page, then edit that bookmark, name it <b>Mope map recorder</b> and replace its address with the code below.</p>
<textarea readonly id=code>${esc(bookmarklet)}</textarea>
<button id=copy>Copy code</button>
</div>

<h2>2. Record on mope.io</h2>
<ol>
<li>Open <b>mope.io</b> and tap the <b>Mope map recorder</b> bookmark (on iPhone, type its name in the address bar and tap it). A black box appears in the corner.</li>
<li>In the box, tap <b>Reconnect</b>, then the game's <b>Try Again</b> button. The game was already connected before the recorder started, and reconnecting makes the server send the map again.</li>
<li>Press Play and travel through every biome: land, the volcano, arctic, desert and both oceans. The box counts what has been seen. The server only sends what is near you, so cover the whole map.</li>
<li>Press <b>Save map file</b>. It downloads <b>mope-map.json</b>.</li>
</ol>

<h2>3. Upload it here</h2>
<div class=card>
<p>Owner accounts only. Every region switches to the recorded map straight away.</p>
<input type=file id=file accept=".json,application/json"> <button id=up>Upload map</button>
<button id=reset>Back to generated map</button>
<p id=msg></p>
</div>
</main>
<script>
copy.onclick = () => { code.select(); navigator.clipboard?.writeText(code.value).then(() => (copy.textContent = "Copied"), () => document.execCommand("copy")); };
const show = async (r) => { const d = await r.json().catch(() => ({})); msg.textContent = r.ok ? d.message : "Failed: " + (d.error || r.status); };
up.onclick = async () => {
  if (!file.files[0]) return (msg.textContent = "Pick the mope-map.json file first.");
  msg.textContent = "Uploading...";
  show(await fetch("/api/map", { method: "POST", headers: { "Content-Type": "application/json" }, body: await file.files[0].text() }));
};
reset.onclick = async () => show(await fetch("/api/map", { method: "DELETE" }));
</script>`;
}
