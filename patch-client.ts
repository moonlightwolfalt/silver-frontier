// Usage: bun run patch-client.ts [dir]   (default: mope-dump/site/mope.io)
// Patches the prettified mope.io client (run `bun run pretty` first) to add:
//   - a "LOCALTEST" server region pointing at ws://localhost:8443 (game-server.js; no Mope
//     directory/Turnstile)
//   - globalThis.localtest.{upgrade,downgrade,up,down}: sandbox helpers that send the same
//     `upgrade`/`downgrade` messages as the arrow-key binds, but only while connected to LOCALTEST.
//   - s3PublicUrl pointed at server.js's /s3/ route, so skins load from the generated assets.
// Files are found by content (their hashed names change on every Mope deploy).
// Idempotent: re-running on an already patched client does nothing.
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const dir = process.argv[2] ?? "mope-dump/site/mope.io";
const files = (await readdir(dir, { recursive: true })).filter((f) => f.endsWith(".js")).map((f) => join(dir, f));
const sources = new Map(await Promise.all(files.map(async (f) => [f, await readFile(f, "utf8")] as const)));

const HELPERS = `
var LOCALTEST_REGION = \`localtest\`,
  LOCALTEST_URL = \`http://localhost:8443\`;
function injectLocaltest(servers, regions) {
  regions[LOCALTEST_REGION] = {
    id: LOCALTEST_REGION,
    name: \`LOCALTEST\`,
    group: \`LOCAL\`,
    countryCode: \`US\`,
    lat: 0,
    lon: 0,
    status: \`online\`,
  };
  (servers.FFA ??= {})[LOCALTEST_REGION] = [
    {
      id: \`localtest-1\`,
      name: \`LOCALTEST\`,
      url: LOCALTEST_URL,
      lat: 0,
      lon: 0,
      countryCode: \`US\`,
      regionId: LOCALTEST_REGION,
      mode: \`FFA\`,
    },
  ];
}
function localtestSend(message, times = 1) {
  if ($.network?.server?.regionId !== LOCALTEST_REGION || !$.player) return false;
  for (let i = 0; i < times; i++) $.network.send(message);
  return true;
}
globalThis.localtest = {
  upgrade: () => localtestSend(\`upgrade\`),
  downgrade: () => localtestSend(\`downgrade\`),
  up: (n = 1) => localtestSend(\`upgrade\`, n),
  down: (n = 1) => localtestSend(\`downgrade\`, n),
};
`;

const S3 = "s3PublicUrl: `https://s3.mope.io/mope-prod` }";
// [from, to, marker]: an edit counts as applied when `to` (or its marker) is already present.
const edits: [string, string, string?][] = [
  // absolute: the client prefixes `./assets/` to any texture path that isn't http(s)
  [`production: { ads: !0, ${S3}`, "production: { ads: !0, s3PublicUrl: `${location.origin}/s3/mope-prod` }"],
  ["var H = n({\n  username: ``,", HELPERS + "var H = n({\n  username: ``,", "var LOCALTEST_REGION"],
  [
    "let { servers: t, regions: n, stats: r, playerCount: i } = await Nl(e);",
    "let { servers: t, regions: n, stats: r, playerCount: i } = await Nl(e);\n      injectLocaltest(t, n);",
  ],
  [
    "} catch (t) {\n      ((H.serversStatus = `error`),",
    "} catch (t) {\n      (injectLocaltest((H.servers = this.config.servers = {}), (H.regions = {})),\n        (H.serversStatus = `ready`),",
  ],
];
const changed = new Set<string>();
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
