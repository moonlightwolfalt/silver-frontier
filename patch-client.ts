// Usage: bun run patch-client.ts [dir]   (default: mope-dump/site/mope.io)
// Patches the prettified mope.io client (run `bun run pretty` first) to add:
//   - a "LOCALTEST" server region pointing at ws://localhost:443 (no Mope directory/Turnstile)
//   - globalThis.localtest.{upgrade,downgrade,up,down}: sandbox helpers that send the same
//     `upgrade`/`downgrade` messages as the arrow-key binds, but only while connected to LOCALTEST.
// Idempotent: re-running on an already patched file does nothing.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const dir = process.argv[2] ?? "mope-dump/site/mope.io";
const file = join(dir, "BoTM2IF7.js");
let src = await readFile(file, "utf8");

const HELPERS = `
var LOCALTEST_REGION = \`localtest\`,
  LOCALTEST_URL = \`http://localhost:443\`;
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

const edits: [string, string][] = [
  ["var H = n({\n  username: ``,", HELPERS + "var H = n({\n  username: ``,"],
  [
    "let { servers: t, regions: n, stats: r, playerCount: i } = await Nl(e);",
    "let { servers: t, regions: n, stats: r, playerCount: i } = await Nl(e);\n      injectLocaltest(t, n);",
  ],
  [
    "} catch (t) {\n      ((H.serversStatus = `error`),",
    "} catch (t) {\n      (injectLocaltest((H.servers = this.config.servers = {}), (H.regions = {})),\n        (H.serversStatus = `ready`),",
  ],
];
let applied = 0;
for (const [from, to] of edits) {
  if (src.includes(to)) continue; // already applied
  if (src.split(from).length !== 2) throw new Error(`expected exactly one match for:\n${from}`);
  src = src.replace(from, () => to);
  applied++;
}
await writeFile(file, src);
console.log(applied ? `patched ${file} (${applied} edits)` : "already patched");
