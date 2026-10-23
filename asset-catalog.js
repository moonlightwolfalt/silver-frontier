// Builds the list of every Mope.io asset the client can load, by reading its own data tables,
// then probes and downloads them into assets/<Category>/<original path>.
//
// Where things live (found by reading the client):
//   - base game textures:  https://mope.io/assets/<path>.webp          (client's `./assets/` paths)
//   - shop skins & ability skins: https://s3.mope.io/mope-prod/items/<itemId>/<file>.webp
//   - item ids:            https://s3.mope.io/mope-prod/translations/items/en.json
// mope.io answers a missing file with 200 text/html (SPA fallback), so a hit is only counted
// when the response is an image or JSON.
import fs from "node:fs";
import path from "node:path";
import * as acorn from "acorn";

export const CATEGORIES = ["Animals", "UI", "Shop Skins", "Foods", "Game Object Assets", "Biomes", "Biome Terrains", "Abilities"];
const SITE = "https://mope.io";
const S3 = "https://s3.mope.io/mope-prod";
const BIOMES = ["land", "ocean", "arctic", "desert", "volcano", "river", "lake", "beach", "swamp", "jungle"];

// ---------- parsing helpers ----------

// Every `X = (function (e) { return ((e[(e.NAME = 0)] = `NAME`), ...), e) })({})` enum.
function parseEnums(src) {
  const enums = {};
  const re = /([\w$]+) = \(function \(e\) \{\s*return \(?\s*((?:\(e\[\(e\.[\w$]+ = -?\d+\)\] = `[^`]*`\),?\s*)+)e\s*\)?;?\s*\}\)\(\{\}\)/g;
  for (const m of src.matchAll(re)) {
    const names = [];
    for (const n of m[2].matchAll(/e\.([\w$]+) = (-?\d+)\)/g)) names[Number(n[2])] = n[1];
    if (names.length) enums[m[1]] = names;
  }
  return enums;
}

// The `var M = zr({ slug: { ... }, ... })` animal table: slug, biome, subspecies and per-form biome.
function parseAnimals(src, enums) {
  const start = src.indexOf("var M = zr({");
  if (start < 0) throw new Error("animal table (var M = zr({) not found in client");
  const body = src.slice(start, src.indexOf("\n});", start));
  const animals = [];
  for (const m of body.matchAll(/^  ([a-z0-9_]+): \{\n([\s\S]*?)^  \},?$/gm)) {
    const [, slug, text] = m;
    const biome = text.match(/^    biome: `(\w+)`/m)?.[1] ?? "land";
    const lava = /^    animalResource: \{ type: 1\b/m.test(text);
    const subs = enums[text.match(/^    subspeciesEnum: ([\w$]+)/m)?.[1]] ?? ["DEFAULT"];
    const overrides = {};
    for (const o of text.matchAll(/\[\s*(\d+),\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}\s*,?\s*\]/g)) {
      const b = o[2].match(/biome: `(\w+)`/)?.[1];
      overrides[o[1]] = /animalResource: \{ type: 1\b/.test(o[2]) ? "volcano" : b;
    }
    const forms = subs.map((name, i) => ({
      slug: !name || name === "DEFAULT" ? "" : name.toLowerCase(),
      biome: overrides[i] ?? (lava ? "volcano" : biome),
      baseBiome: lava ? "volcano" : biome,
    }));
    animals.push({ slug, forms });
  }
  return animals;
}

// Literal suffixes appended to an entity's texturePath (`this.texturePath + \`pigeon_head\``).
function parseTextureSuffixes(src) {
  const out = new Set();
  for (const line of src.split("\n")) {
    if (!line.includes("texturePath +")) continue;
    for (const m of line.matchAll(/`([\w-]+)`/g)) out.add(m[1]);
  }
  return [...out];
}

// Expands `${...}` in a template: inline arrays give their members; any other hole gets small
// numbers, biome names and the path-like string literals found just above it in the code
// (e.g. a switch assigning `ocean/tree/coco`). Only one such open-ended hole is allowed.
function expandTemplate(tpl, nearby = []) {
  if (/\$\{[^}]*$|`/.test(tpl)) return []; // cut-off nested template
  const holes = [...tpl.matchAll(/\$\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g)];
  const isArray = (h) => /^\[(?:\s*`[\w-]+`\s*,?)+\]\[/.test(h[1]);
  if (holes.filter((h) => !isArray(h)).length > 1) return [];
  let results = [tpl];
  for (const h of holes) {
    const arr = h[1].match(/^\[((?:\s*`[\w-]+`\s*,?)+)\]\[/);
    const values = arr
      ? [...arr[1].matchAll(/`([\w-]+)`/g)].map((x) => x[1])
      : [...Array.from({ length: 11 }, (_, i) => String(i)), ...BIOMES, ...nearby];
    results = results.flatMap((r) => values.map((v) => r.replace(h[0], v)));
  }
  return results;
}

const ASSET_DIR = "(?:terrain|abilities|foods|UI|animals|biomes)\\/";

// Every texture path the client spells out: literals and simple templates under a known asset
// folder, `x = \`folder/\`` followed by `x + \`file\`` / `x += \`file\``, and a literal folder
// followed by `+ (cond ? \`a\` : \`b\`)`.
function parsePathLiterals(src) {
  const out = new Set();
  const lines = src.split("\n");
  const nearbyLiterals = (i) =>
    [...lines.slice(Math.max(0, i - 40), i).join("\n").matchAll(/`([a-z][\w-]*(?:\/[\w-]+)*)`/g)].map((m) => m[1]);

  lines.forEach((line, i) => {
    for (const m of line.matchAll(new RegExp(`\`(?:\\.\\/assets\\/|\\/assets\\/|\\/)?(${ASSET_DIR}[^\`]*)\``, "g"))) {
      if (m[1].includes("${")) expandTemplate(m[1], nearbyLiterals(i)).forEach((p) => out.add(p));
      else out.add(m[1]);
    }
    const pre = line.match(new RegExp(`(?:let |, |^\\s+)([\\w$]+) = \`(?:\\.\\/assets\\/)?(${ASSET_DIR}[\\w/-]*\\/)\``));
    if (pre) {
      const window = lines.slice(i, i + 25).join("\n");
      const v = pre[1].replace("$", "\\$");
      for (const m of window.matchAll(new RegExp(`\\b${v} \\+=? \`([\\w./-]+)\``, "g"))) out.add(pre[2] + m[1]);
    }
    const lit = line.match(new RegExp(`\`(${ASSET_DIR}[\\w/-]*\\/)\` \\+\\s*$`));
    if (lit) {
      const next = lines.slice(i + 1, i + 3).join(" ").split(/[,;]\s*$/m)[0];
      for (const m of next.matchAll(/`([\w-]+)`/g)) out.add(lit[1] + m[1]);
    }
  });
  return [...out].filter((p) => !p.endsWith("/") && /^[\w/.-]+$/.test(p));
}

// ---------- abilities ----------

const FIREBALL_FRAMES = ["dynamic", "static"].flatMap((k) => [0, 1, 2, 3, 4].map((n) => `${k}/${n}`));

// Every ability texture and animation frame, base (mope.io/assets/abilities/...) and skins
// (s3 items/abilities/...). Ability classes come from the client's ability class map; each
// class's own texture name and skin enum come from its constructor.
function abilityCandidates(src, enums) {
  const out = [];
  const site = (p) => out.push({ url: `${SITE}/assets/${withExt(p)}`, rel: withExt(p) });
  const s3 = (p) => out.push({ url: `${S3}/items/${withExt(p)}`, rel: `items/${withExt(p)}` });
  const skinsOf = (enumName) => (enums[enumName] ?? []).filter((n) => n && n !== "DEFAULT").map((n) => n.toLowerCase());

  // exact source of each top-level class, so one class's fields never leak into another's
  const classes = new Map();
  for (const node of acorn.parse(src, { ecmaVersion: "latest", sourceType: "module" }).body)
    if (node.type === "VariableDeclaration")
      for (const d of node.declarations) if (d.init?.type === "ClassExpression") classes.set(d.id.name, src.slice(d.init.start, d.init.end));

  const at = src.indexOf("fart: () =>");
  const block = at < 0 ? "" : src.slice(src.lastIndexOf("({", at), src.indexOf("})", at));
  for (const [, name, cls] of block.matchAll(/([a-z_]+): \(\) => ([\w$]+)/g)) {
    const body = classes.get(cls);
    if (!body) continue;
    const texture = body.match(/this\.defaultTextureName = `([\w-]+)`/)?.[1];
    const skins = skinsOf(body.match(/this\.subspeciesEnum = ([\w$]+)/)?.[1]);
    if (name === "fireball") {
      for (const f of FIREBALL_FRAMES) site(`abilities/fireball/${texture ?? "0"}/${f}`);
      for (const skin of skins) for (const f of FIREBALL_FRAMES) s3(`abilities/fireball/${skin}/${f}`);
      continue;
    }
    if (texture) site(`abilities/${name}/${texture}`);
    for (const skin of skins) {
      if (name === "spider_web") s3(`abilities/spider_web/${skin}/spider_web`);
      else if (name === "spit") s3(`abilities/camel/${skin}`), [0, 1, 2].forEach((n) => s3(`abilities/camel/${skin}/spit${n}`));
      else s3(`abilities/${name}/${skin}`);
    }
  }

  // Animal abilities with skins: `let n = Enum[...]` followed by `.../items/abilities/<name>/${n}...`
  for (const m of src.matchAll(/let n = ([\w$]+)\[[^\n]*\n[^\n]*items\/abilities\/([\w]+)\/\$\{n\}([\w/]*)`/g))
    for (const skin of skinsOf(m[1])) s3(`abilities/${m[2]}/${skin}${m[3]}`);
  // Stomp variants for the giraffe family
  for (const v of ["", "white/", "momaffie/", "girabie/"]) site(`abilities/stomp/${v}stomp`);
  // Ostrich egg skins: items/abilities/ostrich_egg/ostrich_<form>/{edible,ostrich_egg}
  const egg = src.match(/items\/abilities\/ostrich_egg\/ostrich_\$\{([\w$]+)\[/);
  if (egg) for (const form of skinsOf(egg[1])) for (const f of ["edible", "ostrich_egg"]) s3(`abilities/ostrich_egg/ostrich_${form}/${f}`);
  return out;
}

// ---------- candidate list ----------

const stem = (s) => s.toLowerCase().replace(/[^a-z]/g, "");
const withExt = (p) => (/\.(webp|png|jpe?g|json|svg)$/.test(p) ? p : `${p}.webp`);

export function buildCandidates(clientDir, itemIds = []) {
  // The main game chunk is the one holding the animal table; its hashed name changes per deploy.
  const texts = fs
    .readdirSync(clientDir, { recursive: true })
    .filter((f) => /\.(js|css|html)$/.test(f))
    .map((f) => fs.readFileSync(path.join(clientDir, f), "utf8"));
  const src = texts.find((t) => t.includes("var M = zr({"));
  if (!src) throw new Error(`no client chunk with the animal table in ${clientDir}`);
  const extra = texts.filter((t) => t !== src).join("\n");
  const enums = parseEnums(src);
  const animals = parseAnimals(src, enums);
  const suffixes = parseTextureSuffixes(src);
  const stems = animals.map((a) => stem(a.slug)).filter((s) => s.length >= 4);

  // Suffixes named after an animal (`pigeon_head`) are only tried on that animal.
  const suffixesFor = (slug) => {
    const own = stem(slug);
    return suffixes.filter((s) => {
      const n = stem(s);
      const owner = stems.filter((st) => n.startsWith(st)).sort((a, b) => b.length - a.length)[0];
      return !owner || own.startsWith(owner) || owner.startsWith(own);
    });
  };

  const list = new Map(); // url -> { category, rel }
  const add = (category, url, rel) => list.has(url) || list.set(url, { category, rel });
  const site = (category, p) => add(category, `${SITE}/assets/${withExt(p)}`, withExt(p));

  // Animals
  for (const a of animals) {
    const files = [`${a.slug}.ui`, ...suffixesFor(a.slug)];
    for (const f of a.forms) {
      for (const biome of new Set([f.biome, f.baseBiome])) {
        const dir = `animals/${biome}/${a.slug}/${f.slug ? f.slug + "/" : ""}`;
        files.forEach((file) => site("Animals", dir + file));
      }
    }
  }

  // Foods: foods/<name>/edible and foods/<name>/<name>, carcasses per subspecies
  for (const name of enums.D ?? []) {
    if (!name) continue;
    site("Foods", `foods/${name}/edible`);
    site("Foods", `foods/${name}/${name}`);
  }
  for (const name of enums.wp ?? []) if (name) site("Foods", `foods/carcass/${name.toLowerCase()}`);

  // Literal paths from the client
  for (const p of parsePathLiterals(src + "\n" + extra)) {
    const [top, second] = p.split("/");
    const category =
      top === "animals" ? "Animals"
      : top === "foods" ? "Foods"
      : top === "biomes" || p.startsWith("UI/tutorial/") ? "Biomes"
      : top === "UI" ? "UI"
      : top === "terrain" && BIOMES.includes(second) ? "Biome Terrains"
      : top === "abilities" ? "Abilities"
      : "Game Object Assets";
    site(category, p);
  }

  // UI and other site images referenced from HTML/CSS/JS (/assets/UI/..., logos)
  for (const m of extra.matchAll(/["'`(]\/?(assets\/[\w./@-]+\.(?:webp|png|svg|jpe?g))/g)) {
    const rel = m[1].replace(/^assets\//, "");
    if (!list.has(`${SITE}/${m[1]}`)) add(rel.startsWith("UI/") ? "UI" : "UI", `${SITE}/${m[1]}`, rel);
  }

  // Shop skins: items/<id>/<species>.ui.webp, the species' body parts, and ability art
  const slugs = animals.map((a) => a.slug).sort((a, b) => b.length - a.length);
  for (const id of itemIds) {
    const species = slugs.find((s) => id === s || id.startsWith(s + "_"));
    const files = species ? [`${species}.ui`, ...suffixesFor(species)] : ["ability", "ability2"];
    for (const f of new Set([...files, "ability", "ability2"]))
      add("Shop Skins", `${S3}/items/${id}/${f}.webp`, `items/${id}/${f}.webp`);
  }
  // Ability skin literals that are prefixed with the S3 items URL in the client
  for (const m of src.matchAll(/\+ `(abilities\/[\w/-]+)`/g))
    add("Abilities", `${S3}/items/${withExt(m[1])}`, `items/${withExt(m[1])}`);

  for (const { url, rel } of abilityCandidates(src, enums)) add("Abilities", url, rel);

  return { candidates: [...list].map(([url, v]) => ({ url, ...v })), animals, enums };
}

// ---------- download ----------

async function fetchItemIds() {
  try {
    const r = await fetch(`${S3}/translations/items/en.json`);
    return r.ok ? Object.keys(await r.json()) : [];
  } catch {
    return [];
  }
}

const isAsset = (type) => !!type && !/text\/html|application\/xml/.test(type);

// Per-host parallelism: s3.mope.io is slow per request but takes load fine; mope.io sits
// behind Cloudflare, so it stays narrower.
const CONCURRENCY = { "mope.io": 24, "s3.mope.io": 96 };

export async function generate({ clientDir, outDir, concurrency = CONCURRENCY, log = console.log }) {
  const itemIds = await fetchItemIds();
  const { candidates } = buildCandidates(clientDir, itemIds);
  log(`${candidates.length} candidate URLs (${itemIds.length} shop items)`);

  // Known misses are skipped on later runs; delete assets/.misses.json to re-probe everything.
  const missFile = path.join(outDir, ".misses.json");
  let misses = new Set();
  try { misses = new Set(JSON.parse(fs.readFileSync(missFile, "utf8"))); } catch {}
  const saveMisses = () => {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(missFile, JSON.stringify([...misses]));
  };

  const index = Object.fromEntries(CATEGORIES.map((c) => [c, []]));
  let done = 0, hits = 0;
  const check = async (c) => {
    const file = path.join(outDir, c.category, c.rel);
    const entry = { file: `${c.category}/${c.rel}`, source: c.url };
    if (fs.existsSync(file)) { index[c.category].push(entry); hits++; }
    else if (!misses.has(c.url)) {
      try {
        const r = await fetch(c.url);
        const type = r.headers.get("content-type");
        if (r.ok && isAsset(type)) {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
          index[c.category].push(entry);
          hits++;
        } else {
          await r.body?.cancel();
          if (r.status !== 429 && r.status < 500) misses.add(c.url);
        }
      } catch {}
    }
    if (++done % 1000 === 0) {
      log(`  ${done}/${candidates.length} checked, ${hits} found`);
      saveMisses();
    }
  };

  const byHost = Map.groupBy(candidates, (c) => new URL(c.url).host);
  await Promise.all(
    [...byHost].flatMap(([host, queue]) =>
      Array.from({ length: concurrency[host] ?? 16 }, async () => {
        for (let c; (c = queue.shift()); ) await check(c);
      }),
    ),
  );

  for (const list of Object.values(index)) list.sort((a, b) => a.file.localeCompare(b.file));
  fs.writeFileSync(path.join(outDir, "index.json"), JSON.stringify(index, null, 2));
  saveMisses();
  for (const c of CATEGORIES) log(`${c}: ${index[c].length}`);
  return index;
}
