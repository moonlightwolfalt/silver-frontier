// Usage: bun run patch-client.ts [dir]   (default: mope-dump/site/mope.io)
// Patches the prettified mope.io client (run `bun run pretty` first) into a private-server client:
//   - the server list is replaced by the local regions in regions.js, each with an FFA and a
//     PARTY server at ws(s)://<this host>/play/<region>[/new] (no Mope directory or Turnstile);
//     player counts come from /api/servers
//   - the account API (axisURL) and skin/translation files (s3PublicUrl) point at this server
//   - globalThis.localtest.{upgrade,downgrade,up,down}: console helpers that send the same
//     `upgrade`/`downgrade` messages as the arrow-key binds while on a local server
// Files are found by content (their hashed names change on every Mope deploy). Re-running is
// safe: the injected block sits between markers and is replaced, other edits are skipped.
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REGIONS } from "./regions.js";

const dir = process.argv[2] ?? "mope-dump/site/mope.io";
const files = (await readdir(dir, { recursive: true })).filter((f) => f.endsWith(".js")).map((f) => join(dir, f));
const sources = new Map(await Promise.all(files.map(async (f) => [f, await readFile(f, "utf8")] as const)));

const GROUPS: Record<string, string> = { US: "AMERICA", BR: "SOUTH_AMERICA", EU: "EUROPE", SG: "ASIA", AU: "OCEANIA" };
const BEGIN = "/* private-server:begin */";
const END = "/* private-server:end */";
const HELPERS = `${BEGIN}
var LOCAL_REGIONS = ${JSON.stringify(REGIONS.map((r) => ({ ...r, group: GROUPS[r.countryCode] ?? "AMERICA" })))};
async function localServers() {
  let stats = {};
  try {
    stats = await (await fetch(\`\${location.origin}/api/servers\`)).json();
  } catch {}
  let servers = { FFA: {}, PARTY: {} },
    regions = {},
    playerCount = 0;
  for (let r of LOCAL_REGIONS) {
    let id = \`local-\${r.id}\`;
    regions[id] = { id, name: r.name, group: r.group, countryCode: r.countryCode, lat: r.lat, lon: r.lon, status: \`online\` };
    for (let [mode, suffix] of [[\`FFA\`, \`\`], [\`PARTY\`, \`/new\`]]) {
      let serverId = mode === \`FFA\` ? id : \`\${id}-party\`;
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
};
${END}
`;

// [from, to, marker]: an edit counts as applied when `to` (or its marker) is already present.
const edits: [string, string, string?][] = [
  // absolute: the client prefixes `./assets/` to any texture path that isn't http(s)
  ["production: { ads: !0, s3PublicUrl: `https://s3.mope.io/mope-prod` }", "production: { ads: !0, s3PublicUrl: `${location.origin}/s3/mope-prod` }"],
  ["production: { axisURL: `https://api.mope.io` }", "production: { axisURL: `${location.origin}/api` }"],
  ["var H = n({\n  username: ``,", HELPERS + "var H = n({\n  username: ``,", BEGIN],
  // Only our regions: the Mope directory is never asked.
  [
    "let { servers: t, regions: n, stats: r, playerCount: i } = await Nl(e);",
    "let { servers: t, regions: n, stats: r, playerCount: i } = await localServers();",
  ],
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
for (const file of changed) await writeFile(file, sources.get(file)!);
console.log(changed.size ? `patched ${[...changed].join(", ")}` : "already patched");
