// Usage: bun run patch-client.ts [dir]   (default: mope-dump/site/mope.io)
// Patches the prettified mope.io client (run `bun run pretty` first) into a private-server client:
//   - the server list is replaced by the local regions in regions.js, each with an FFA and a
//     PARTY server at ws(s)://<this host>/play/<region>[/new] (no Mope directory or Turnstile);
//     player counts come from /api/servers
//   - the account API (axisURL) and skin/translation files (s3PublicUrl) point at this server
//   - extra pumpkin variants from pumpkins.js (textures, a 4-bit variant id, minimap colours)
//   - globalThis.localtest.{upgrade,downgrade,up,down}: console helpers that send the same
//     `upgrade`/`downgrade` messages as the arrow-key binds while on a local server
// Files are found by content (their hashed names change on every Mope deploy). Re-running is
// safe: the injected block sits between markers and is replaced, other edits are skipped.
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REGIONS } from "./regions.js";
import { PUMPKINS, PUMPKIN_COLOURS } from "./pumpkins.js";
import { MAX_XP, TIER_XP } from "./limits.js";
import { CUSTOM } from "./custom-biomes.js";
import { MODE_LIST } from "./mode-list.js";
import { CUSTOM_ACHIEVEMENTS } from "./progress.js";

const dir = process.argv[2] ?? "mope-dump/site/mope.io";
const files = (await readdir(dir, { recursive: true })).filter((f) => f.endsWith(".js")).map((f) => join(dir, f));
const sources = new Map(await Promise.all(files.map(async (f) => [f, await readFile(f, "utf8")] as const)));

const GROUPS: Record<string, string> = { US: "AMERICA", BR: "SOUTH_AMERICA", EU: "EUROPE", SG: "ASIA", AU: "OCEANIA" };
const BEGIN = "/* private-server:begin */";
const END = "/* private-server:end */";
const HELPERS = `${BEGIN}
var LOCAL_MODES = ${JSON.stringify(MODE_LIST)};
var LOCAL_REGIONS = ${JSON.stringify(REGIONS.map((r) => ({ ...r, group: GROUPS[r.countryCode] ?? "AMERICA" })))};
async function localServers() {
  let stats = {};
  try {
    stats = await (await fetch(\`\${location.origin}/api/servers\`)).json();
  } catch {}
  let servers = Object.fromEntries(LOCAL_MODES.map(([, label]) => [label, {}])),
    regions = {},
    playerCount = 0;
  for (let r of LOCAL_REGIONS) {
    let id = \`local-\${r.id}\`;
    regions[id] = { id, name: r.name, group: r.group, countryCode: r.countryCode, lat: r.lat, lon: r.lon, status: \`online\` };
    for (let [key, mode, suffix] of LOCAL_MODES) {
      let serverId = key === \`FFA\` ? id : \`\${id}-\${key.toLowerCase()}\`;
      servers[mode][id] = [
        { id: serverId, name: r.name, url: \`\${location.origin}/play/\${r.id}\${suffix}\`, lat: r.lat, lon: r.lon,
          countryCode: r.countryCode, regionId: id, mode },
      ];
    }
    playerCount += stats[r.id] ?? 0;
  }
  let serverStats = Object.fromEntries(LOCAL_REGIONS.map((r) => [\`local-\${r.id}\`, { players: stats[r.id] ?? 0, full: !1 }]));
  return { servers, regions, stats: serverStats, playerCount };
}
function localtestSend(message, times = 1) {
  if (!String($.network?.server?.regionId ?? \`\`).startsWith(\`local-\`) || !$.player) return false;
  for (let i = 0; i < times; i++) $.network.send(message);
  return true;
}
globalThis.localtest = {
  upgrade: () => localtestSend(\`upgrade\`),
  downgrade: () => localtestSend(\`downgrade\`),
  up: (n = 1) => localtestSend(\`upgrade\`, n),
  down: (n = 1) => localtestSend(\`downgrade\`, n),
  mapBounds: () => ({ x: $.map.bounds.max.x, y: $.map.bounds.max.y }), // for checking the server's MAP
};
// On-screen sandbox buttons: the same messages as the Up/Down binds. Shown only while playing
// on a local server; presses don't reach the game's own pointer handlers (no accidental boost).
(function sandboxButtons() {
  if (typeof document === \`undefined\`) return;
  let style = document.createElement(\`style\`);
  style.textContent = \`
    #sandboxButtons{position:fixed;right:12px;top:50%;transform:translateY(-50%);z-index:50;display:none;flex-direction:column;gap:8px}
    #sandboxButtons button{min-width:116px;padding:10px 14px;border:0;border-radius:12px;font:700 15px Rubik,system-ui,sans-serif;color:#fff;
      background:#1f9e3a;box-shadow:inset 0 -4px 0 #0007,0 2px 6px #0004;cursor:pointer;touch-action:manipulation;user-select:none}
    #sandboxButtons button:active{transform:translateY(2px);box-shadow:inset 0 -2px 0 #0007}
    #sandboxButtons button.down{background:#b8452f}
    #sandboxButtons button:focus-visible{outline:3px solid #fff;outline-offset:2px}\`;
  let box = document.createElement(\`div\`);
  box.id = \`sandboxButtons\`;
  box.setAttribute(\`aria-label\`, \`Sandbox upgrades\`);
  for (let [label, message, cls] of [[\`▲ Upgrade\`, \`upgrade\`, \`up\`], [\`▼ Downgrade\`, \`downgrade\`, \`down\`]]) {
    let b = document.createElement(\`button\`);
    b.type = \`button\`;
    b.className = cls;
    b.textContent = label;
    b.title = message === \`upgrade\` ? \`Sandbox: show the next tier (Up arrow)\` : \`Sandbox: show the previous tier (Down arrow)\`;
    for (let ev of [\`pointerdown\`, \`mousedown\`, \`touchstart\`, \`pointerup\`, \`mouseup\`, \`touchend\`])
      b.addEventListener(ev, (e) => e.stopPropagation(), { passive: !0 });
    b.addEventListener(\`click\`, (e) => {
      (e.stopPropagation(), localtestSend(message), b.blur());
    });
    box.appendChild(b);
  }
  let mount = () => (document.head.appendChild(style), document.body.appendChild(box));
  document.body ? mount() : window.addEventListener(\`DOMContentLoaded\`, mount);
  setInterval(() => {
    let show = !!$?.player && String($.network?.server?.regionId ?? \`\`).startsWith(\`local-\`);
    box.style.display = show ? \`flex\` : \`none\`;
  }, 250);
})();
// Action menu (left edge): one tap for the chat commands phones can't easily type, such as 1v1s,
// tournaments, ranked and teams. The server's reply shows in chat as usual.
(function actionMenu() {
  if (typeof document === \`undefined\`) return;
  let style = document.createElement(\`style\`);
  style.textContent = \`
    #sfActions{position:fixed;left:12px;top:50%;transform:translateY(-50%);z-index:50;display:none;align-items:center;gap:8px}
    #sfActions>button,#sfActionList button{border:0;font:700 14px Rubik,system-ui,sans-serif;color:#fff;cursor:pointer;
      touch-action:manipulation;user-select:none;box-shadow:inset 0 -4px 0 #0007,0 2px 6px #0004}
    #sfActions>button{width:52px;height:52px;border-radius:50%;background:#2d6bc4;font-size:24px}
    #sfActions>button[aria-expanded=true]{background:#1d4580}
    #sfActionList{display:none;flex-direction:column;gap:6px}
    #sfActions>button[aria-expanded=true]+#sfActionList{display:flex}
    #sfActionList button{padding:9px 12px;border-radius:12px;background:#2d6bc4;text-align:left;white-space:nowrap}
    #sfActions button:active{transform:translateY(2px);box-shadow:inset 0 -2px 0 #0007}
    #sfActions button:focus-visible{outline:3px solid #fff;outline-offset:2px}
    @media (max-width:600px),(max-height:500px){
      #sfActions>button{width:44px;height:44px;font-size:20px}
      #sfActionList button{padding:7px 10px;font-size:13px}
      #sandboxButtons button{min-width:0;padding:7px 10px;font-size:13px}}
    @media (max-height:500px){#sandboxButtons{flex-direction:row;top:44%}}\`;
  let box = document.createElement(\`div\`);
  box.id = \`sfActions\`;
  let toggle = document.createElement(\`button\`);
  toggle.type = \`button\`;
  toggle.textContent = \`⚔️\`;
  toggle.title = \`Actions: 1v1, tournaments, rank, team\`;
  toggle.setAttribute(\`aria-label\`, toggle.title);
  toggle.setAttribute(\`aria-expanded\`, \`false\`);
  toggle.setAttribute(\`aria-controls\`, \`sfActionList\`);
  let list = document.createElement(\`div\`);
  list.id = \`sfActionList\`;
  let actions = [
    [\`⚔️ 1v1 the nearest\`, \`/1v1\`],
    [\`🏆 Join tournament\`, \`/join\`],
    [\`📋 Tournament\`, \`/tournament\`],
    [\`📈 My rank\`, \`/rank\`],
    [\`👥 Team\`, \`/team\`],
    [\`🌍 World records\`, \`/top\`],
    [\`❔ Commands\`, \`/help\`],
  ];
  let shield = (b) => {
    for (let ev of [\`pointerdown\`, \`mousedown\`, \`touchstart\`, \`pointerup\`, \`mouseup\`, \`touchend\`])
      b.addEventListener(ev, (e) => e.stopPropagation(), { passive: !0 });
  };
  let open = (yes) => toggle.setAttribute(\`aria-expanded\`, String(yes));
  shield(toggle);
  toggle.addEventListener(\`click\`, (e) => {
    (e.stopPropagation(), open(toggle.getAttribute(\`aria-expanded\`) !== \`true\`), toggle.blur());
  });
  for (let [label, chat] of actions) {
    let b = document.createElement(\`button\`);
    b.type = \`button\`;
    b.textContent = label;
    shield(b);
    b.addEventListener(\`click\`, (e) => {
      e.stopPropagation();
      $.player && $.network?.send(\`chatMessage\`, { chat });
      (open(!1), b.blur());
    });
    list.appendChild(b);
  }
  box.append(toggle, list);
  let mount = () => (document.head.appendChild(style), document.body.appendChild(box));
  document.body ? mount() : window.addEventListener(\`DOMContentLoaded\`, mount);
  setInterval(() => {
    let show = !!$?.player && String($.network?.server?.regionId ?? \`\`).startsWith(\`local-\`);
    box.style.display = show ? \`flex\` : \`none\`;
    show || open(!1);
  }, 250);
})();
// Custom biomes: classes for the new animals and foods (built once, on first use), and switching
// the map between the surface and the layer worlds when the server says so.
function __cbAnimal(n) {
  let c = (globalThis.__cbA ??= {});
  return (c[n] ??= class extends W {});
}
function __cbFood(n) {
  let c = (globalThis.__cbF ??= {});
  return (c[n] ??= class extends G {});
}
function __cbSetLayer(name) {
  let surface = (globalThis.__cbSurface ??= JSON.parse(JSON.stringify(pg.biomes)));
  if ((globalThis.__cbLayer ?? \`surface\`) === name) return;
  let w = 0,
    h = 0;
  for (let b of Object.values(surface)) ((w = Math.max(w, b.x + b.width / 2)), (h = Math.max(h, b.y + b.height / 2)));
  let next = name === \`surface\` ? surface : { [name]: { x: w / 2, y: h / 2, z: 1, width: w, height: h } };
  for (let k of Object.keys(pg.biomes)) delete pg.biomes[k];
  Object.assign(pg.biomes, JSON.parse(JSON.stringify(next)));
  globalThis.__cbLayer = name;
  let m = $.map;
  if (!m) return;
  ((m.biomes = m.generateBiomes(pg.biomes)), (m.shape = m.generateShape()));
  m.init().then(() => $.minimap?.generate?.());
}
globalThis.__sfChangelog = () =>
  (globalThis.__sfChangelogP ??= fetch(\`\${location.origin}/api/changelog\`).then((r) => (r.ok ? r.json() : null)).catch(() => null));
function __cbLayerMessage(e) {
  let m = e?.message;
  if (typeof m !== \`string\` || !m.startsWith(\`\\u0001layer:\`)) return !1;
  return (__cbSetLayer(m.slice(7)), !0);
}
${END}
`;

// [from, to, marker]: an edit counts as applied when `to` (or its marker) is already present.
const edits: [string, string, string?][] = [
  // absolute: the client prefixes `./assets/` to any texture path that isn't http(s)
  ["production: { ads: !0, s3PublicUrl: `https://s3.mope.io/mope-prod` }", "production: { ads: !0, s3PublicUrl: `${location.origin}/s3/mope-prod` }"],
  ["production: { axisURL: `https://api.mope.io` }", "production: { axisURL: `${location.origin}/api` }"],
  ["var H = n({\n  username: ``,", HELPERS + "var H = n({\n  username: ``,", BEGIN],
  // Pumpkin variants: texture folder per id, 4 bits for 11 variants, names, minimap colours.
  [
    "`terrain/pumpkin/${[`normal`, `jack`, `gold`, `emerald`, `ruby`, `diamond`, `onyx`][this.subspecies]}`",
    `\`terrain/pumpkin/\${[${PUMPKINS.map((p) => "`" + p.id + "`").join(", ")}][this.subspecies]}\``,
  ],
  ["e instanceof x && (this.subspecies = e.readBits(3)),", "e instanceof x && (this.subspecies = e.readBits(4)),"],
  [
    "(e[(e.ONYX = 6)] = `ONYX`),",
    "(e[(e.ONYX = 6)] = `ONYX`)," +
      PUMPKINS.slice(7).map((p, i) => `(e[(e.${p.id.toUpperCase()} = ${i + 7})] = \`${p.id.toUpperCase()}\`),`).join(""),
  ],
  [
    "var ng = [`#ffa500`, `#deb887`, `#ffd700`, `#6adb41`, `#e4384c`, `#38e4e1`],",
    `var ng = [${PUMPKIN_COLOURS.map((c) => "`" + c + "`").join(", ")}],`,
  ],
  // XP above 4.29B: the live XP value and the death screen's XP become 64-bit floats, which hold
  // whole numbers exactly up to 9 quadrillion (the client's bit writer can't do >32-bit integers).
  [
    "xp: { fields: { xp: { type: C.Integer, bits: 32 }, rank: { type: C.Integer, bits: 16 } } },",
    "xp: { fields: { xp: { type: C.Float64 }, rank: { type: C.Integer, bits: 16 } } },",
  ],
  [
    "stopGameSession: {\n      fields: {\n        xp: { type: C.Integer, bits: 32 },",
    "stopGameSession: {\n      fields: {\n        xp: { type: C.Float64 },",
  ],
  // XP bar at tier 17: progress toward the XP cap ("1.5B / 10T XP") instead of a bare total,
  // filled on a log scale like tier 17's growth (each ×10 in XP fills the same amount).
  [
    "Aa(Lr[e.tier - 1].requiredXP, Lr[e.tier]?.requiredXP ?? 4e7, Lr[e.tier] !== void 0),",
    `Aa(Lr[e.tier - 1].requiredXP, Lr[e.tier]?.requiredXP ?? ${MAX_XP}, Lr[e.tier] !== void 0),`,
  ],
  [
    "n = t > 0 ? Be(((e - wa) / t) * 100, 0, 100) : 100;",
    "n = t > 0 ? Be((Ea ? (e > wa ? Math.log(e / wa) / Math.log(Ta / wa) : 0) : (e - wa) / t) * 100, 0, 100) : 100;",
  ],
  [
    "(ba.xp.label = F(Ea ? `hud:stats.bar.xpBarTop` : `hud:stats.bar.xpBar`, {",
    "(ba.xp.label = Ea\n      ? `${i} ${F(`hud:stats.xp`)} / ${a} ${F(`hud:stats.xp`)}`\n      : F(`hud:stats.bar.xpBar`, {",
  ],
  // In-game leaderboard XP as 64 bits (scores past 4.29B), and the hole goal ring's pumpkin
  // variant as 4 bits (our extra pumpkins are 7-10).
  [
    "let i = e.readUint16(),\n        a = e.readUint32();\n      if ((i === $.playerID",
    "let i = e.readUint16(),\n        a = e.readFloat64();\n      if ((i === $.playerID",
  ],
  ["this.initGoal(e.readBits(3));", "this.initGoal(e.readBits(4));"],
  // The menu Leaderboard opens on the all-time Most XP board (records.js).
  [
    "var Q = e({ open: !1, period: `weekly`, statKey: `players_eaten`, chains: !1 });",
    "var Q = e({ open: !1, period: `all-time`, statKey: `most_xp`, chains: !1 });",
  ],
  // Only our regions: the Mope directory is never asked.
  [
    "let { servers: t, regions: n, stats: r, playerCount: i } = await Nl(e);",
    "let { servers: t, regions: n, stats: r, playerCount: i } = await localServers();",
  ],
  // Custom biomes travel as land, so the wrong-biome hint skips animals from them.
  [
    "              ? t\n              : E[t];\n      return n === void 0 || e.biome === n",
    "              ? t\n              : E[t] > E.volcano\n                ? void 0\n                : E[t];\n      return n === void 0 || e.biome === n",
  ],
  // The changelog box shows this server's commits (/api/changelog) instead of mope.io's notes.
  [
    "async function Pf(e) {\n  let t = pr(e) ? e : `en`,",
    "async function Pf(e) {\n  let __sf = await globalThis.__sfChangelog?.();\n  if (__sf?.versions?.length) return __sf;\n  let t = pr(e) ? e : `en`,",
  ],
  // Quests pay coins here, not pass XP.
  ["xpReward: `{xp, number} XP`,", "xpReward: `{xp, number} coins`,"],
  // Layer switches (custom biomes) ride on serverMessage with a \u0001layer: prefix.
  ["w.on(`serverMessage`, function (e) {\n", "w.on(`serverMessage`, function (e) {\n  if (__cbLayerMessage(e)) return;\n"],
];

const changed = new Set<string>();
// Replace an earlier injected block with the current one.
for (const [file, src] of sources) {
  const a = src.indexOf(BEGIN), b = src.indexOf(END);
  if (a >= 0 && b > a && src.slice(a, b + END.length + 1) !== HELPERS) {
    sources.set(file, src.slice(0, a) + HELPERS + src.slice(b + END.length + 1));
    changed.add(file);
  }
}
for (const [from, to, marker = to] of edits) {
  if ([...sources.values()].some((src) => src.includes(marker))) continue; // already applied
  const hits = [...sources].filter(([, src]) => src.split(from).length === 2);
  if (hits.length !== 1) throw new Error(`expected exactly one match in the client for:\n${from}`);
  const [file, src] = hits[0];
  sources.set(file, src.replace(from, () => to));
  changed.add(file);
}
// Tier XP requirements (Lr) from limits.js: tier 17 at 1T instead of 10M.
for (const [file, src] of sources) {
  const a = src.indexOf("\n  Lr = [\n");
  if (a < 0) continue;
  const b = src.indexOf("\n  ],\n", a);
  let i = 0;
  const table = src.slice(a, b).replace(/requiredXP: [\de.]+/g, () => `requiredXP: ${TIER_XP[i++]}`);
  if (i !== TIER_XP.length) throw new Error(`expected ${TIER_XP.length} tiers in Lr, found ${i}`);
  if (table !== src.slice(a, b)) sources.set(file, src.slice(0, a) + table + src.slice(b)), changed.add(file);
}
// ---------- custom biomes (custom-biomes.json) ----------
// New animals, foods and biome names go into the client's own tables, each insertion wrapped in
// /*cb:<tag>*/ ... /*cb:<tag>:end*/ right after a fixed anchor, so re-running replaces it.
const cbOpen = (tag: string) => `/*cb:${tag}*/`;
const cbClose = (tag: string) => `/*cb:${tag}:end*/`;
const stripCb = (text: string, tag: string) => {
  const a = text.indexOf(cbOpen(tag));
  return a < 0 ? text : text.slice(0, a) + text.slice(text.indexOf(cbClose(tag)) + cbClose(tag).length);
};
function cbFind(anchor: string): [string, string, number] {
  const hits = [...sources].filter(([, src]) => src.includes(anchor));
  if (hits.length !== 1 || hits[0][1].split(anchor).length !== 2) throw new Error(`custom biomes: expected one match for:\n${anchor}`);
  const [file, src] = hits[0];
  return [file, src, src.indexOf(anchor) + anchor.length];
}
function cbUpsert(anchor: string, tag: string, code: string) {
  const [file, src, at] = cbFind(anchor);
  let rest = src.slice(at);
  if (rest.startsWith(cbOpen(tag))) rest = rest.slice(rest.indexOf(cbClose(tag)) + cbClose(tag).length);
  const next = src.slice(0, at) + cbOpen(tag) + code + cbClose(tag) + rest;
  if (next !== src) sources.set(file, next), changed.add(file);
}
// Highest id in the enum that starts at `anchor`, not counting our own entries.
function cbEnumNext(anchor: string, tag: string) {
  const [, src, at] = cbFind(anchor);
  const body = stripCb(src.slice(at - anchor.length, src.indexOf("\n      e\n    );", at)), tag);
  return Math.max(...[...body.matchAll(/ = (\d+)\)\]/g)].map((m) => +m[1])) + 1;
}
const tick = (s: string) => "`" + s.replace(/[`\\$]/g, (c) => "\\" + c) + "`";
const enumEntries = (names: string[], first: number) => names.map((n, i) => `(e[(e.${n} = ${first + i})] = ${tick(n)}),`).join("");

const biomeIds = Object.keys(CUSTOM.biomes);
// Bosses are animals to the client (sprites, names, abilities) but in no tier's upgrade menu.
const BOSSES = CUSTOM.bosses ?? [];
const creatures = [...CUSTOM.animals, ...BOSSES];
cbUpsert("(e[(e.mouse = 0)] = `mouse`),", "T", enumEntries(creatures.map((a: any) => a.slug), cbEnumNext("(e[(e.mouse = 0)] = `mouse`),", "T")));
cbUpsert("(e[(e.berry = 1)] = `berry`),", "D", enumEntries(CUSTOM.foods.map((f: any) => f.slug), cbEnumNext("(e[(e.berry = 1)] = `berry`),", "D")));
cbUpsert("(e[(e.volcano = 4)] = `volcano`),", "E", enumEntries(biomeIds, cbEnumNext("(e[(e.volcano = 4)] = `volcano`),", "E")));

const WATER_PLANS = new Set(["fish", "whale", "squid", "jelly"]);
const speedsOf = (a: any) => {
  const s = { ...CUSTOM.biomes[a.biome].speeds };
  if (WATER_PLANS.has(a.plan) && a.biome === "swamp") Object.assign(s, { land: 0.4, water: 1, mud: 1 });
  return s;
};
const BOSS_SPEEDS: Record<string, any> = { ocean: { land: 0.3, water: 1, mud: 0.5 } };
cbUpsert("var M = zr({\n", "M", "\n" + creatures.map((a: any) => {
  const boss = !a.tier;
  const sp = boss ? BOSS_SPEEDS[a.biome] ?? { land: 1, water: 0.6, mud: 0.8 } : speedsOf(a);
  const zones = [sp.land >= 0.8 && 0, sp.water >= 0.8 && 1, sp.mud >= 0.8 && 2].filter((z) => z !== false);
  const [min, max] = boss ? a.size : CUSTOM.sizes[a.tier];
  return `  ${a.slug}: { comfortZones: new j([${zones.join(", ")}]), ability1Duration: 1 / 0, ability1InputMode: \`hold\`, biome: ${tick(a.biome)}, biomes: [${tick(a.biome)}], minimumSize: ${min}, maximumSize: ${max}, terrainSpeedComfort: { land: ${sp.land}, water: ${sp.water}, mud: ${sp.mud} }${boss ? ", showInUpgradeMenu: !1" : ""} },\n`;
}).join(""));
cbUpsert("var Ul = {\n", "Ul", "\n" + CUSTOM.foods.map((f: any) => `  ${f.slug}: { minimumTier: ${f.tiers[0]}, maximumTier: ${f.tiers[1]} },\n`).join(""));
cbUpsert("  dp = e({\n", "dp", "\n" + creatures.map((a: any) => `    ${a.slug}: () => __cbAnimal(${tick(a.slug)}),\n`).join(""));
cbUpsert("  am = e({\n", "am", "\n" + CUSTOM.foods.map((f: any) => `    ${f.slug}: () => __cbFood(${tick(f.slug)}),\n`).join(""));
cbUpsert("  vi = {\n", "vi", "\n" + creatures.map((a: any) =>
  `    ${a.slug}: { name: ${tick(a.name)}, ability1: ${tick(a.ability ?? "")}, description: ${tick(a.description ?? "")} },\n`).join(""));
cbUpsert("    biomes: {\n      land: `#24B645`,\n", "colors", "\n" + biomeIds.map((id) => `      ${id}: ${tick(CUSTOM.biomes[id].color)},\n`).join(""));
cbUpsert("    outline: {\n      land: `#09992F`,\n", "outline", "\n" + biomeIds.map((id) => `      ${id}: ${tick(CUSTOM.biomes[id].foodOutline)},\n`).join(""));
cbUpsert("var pg = {\n    scale: 1,\n    biomes: {\n", "pg", "\n" + biomeIds.filter((id) => CUSTOM.biomes[id].kind === "area").map((id) => {
  const r = CUSTOM.biomes[id].area;
  return `      ${id}: { x: ${r.x}, y: ${r.y}, z: 2, width: ${r.width}, height: ${r.height} },\n`;
}).join(""));
// This server's achievements (progress.js) join the client's list (X_) and its names.
cbUpsert("var X_ = [\n", "X_", "\n" + CUSTOM_ACHIEVEMENTS.map((a: any) =>
  `    { id: ${tick(a.id)}, tier: ${tick(a.tier)}, metric: ${tick(a.metric)}, goal: ${a.goal}, scope: ${tick(a.scope)}, reward: { coins: ${a.reward.coins ?? 0}, gems: ${a.reward.gems ?? 0} } },\n`).join(""));
cbUpsert("      first_bite: { name: `First Bite`, description: `Eat another player.` },\n", "achNames", CUSTOM_ACHIEVEMENTS.map((a: any) =>
  `      ${a.id}: { name: ${tick(a.name)}, description: ${tick(a.description)} },\n`).join(""));

// Each tier's animals in Lr gain that tier's custom animals.
{
  const anchor = "\n  Lr = [\n";
  const [file, src, at] = cbFind(anchor);
  const end = src.indexOf("\n  ],\n", at);
  let tier = 0;
  const table = src.slice(at, end).replace(/animals: \[([^\]]*?)(\/\*cb:Lr\*\/[^\]]*?\/\*cb:Lr:end\*\/)?\]/g, (_m, list) => {
    tier++;
    const extra = CUSTOM.animals.filter((a: any) => a.tier === tier).map((a: any) => `T.${a.slug}`);
    return `animals: [${list.replace(/[\s,]+$/, "")}${extra.length ? `${cbOpen("Lr")}, ${extra.join(", ")}${cbClose("Lr")}` : ""}]`;
  });
  if (tier !== 17) throw new Error(`custom biomes: expected 17 tiers in Lr, found ${tier}`);
  if (table !== src.slice(at, end)) sources.set(file, src.slice(0, at) + table + src.slice(end)), changed.add(file);
}

for (const file of changed) await writeFile(file, sources.get(file)!);
console.log(changed.size ? `patched ${[...changed].join(", ")}` : "already patched");
