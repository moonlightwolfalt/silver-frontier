// Generates the static world for a lobby: terrain objects and foods for every biome, laid out on
// the client's own map (pg.biomes). Every entry is { type, species, biome, x, y, size, ... } using
// the client's enums, ready for game-server.js to encode.
//
// Mope's real server decides these server-side, so the counts, sizes and food lists below are our
// own choices, picked to look like a normal Mope map.

import { CUSTOM } from "./custom-biomes.js";

// Custom foods by biome (custom-biomes.json).
export const CUSTOM_FOODS = Object.fromEntries(Object.keys(CUSTOM.biomes).map((id) => [id, CUSTOM.foods.filter((f) => f.biome === id).map((f) => f.slug)]));
const CUSTOM_BIG = new Set(CUSTOM.foods.filter((f) => f.big).map((f) => f.slug));

// Seeded PRNG so each lobby's map is stable across restarts.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

// Food lists per biome. A name repeated is picked more often; a [name, weight] pair sets the weight.
export const FOODS = {
  land: [
    "berry", "berry", "berry", "mushroom", "mushroom", "red_mushroom", "mushroom_bush", "carrot", "carrot",
    "pear", "raspberry", "raspberry", "watermelon", "watermelon_slice", "melon", "melon_slice", "orange",
    "mango", "banana", "duck_egg", "honeycomb", ["golden_egg", 0.15],
  ],
  arctic: ["cloud_berry", "cloud_berry", "cloud_berry", "nut", "nut", "berry", "mushroom", "raspberry"],
  desert: ["cactus", "cactus_pear", "cactus_pear", "date", "date", "aloevera", "aloevera_leaf", "aloevera_leaf", "melon", "ostrich_egg"],
  ocean: ["kelp", "kelp", "sea_weed", "sea_weed", "clam", "conch", "starfish", "starfish", "coconut"],
  volcano: ["pepper", "pepper", "flesh", "bone"],
  lake: ["lilypad", "lilypad", "water"],
  // Put out around the giant cakes, smallest first (each is for bigger animals than the last).
  party: ["cake_crumb", "cake_crumb", "cake_crumb", "cookie", "cookie", "cupcake", "cupcake", "cake_slice", ["gift", 0.5]],
};
// Foods drawn larger than the usual 14-24.
const BIG_FOODS = new Set(["mushroom_bush", "melon", "watermelon", "coconut", "beehive", "cactus", "aloevera", "conch", "gift", "cake_slice", "ostrich_egg"]);
// Party foods with a 3-bit style (textures 1-7).
export const STYLED_FOODS = new Set(["cupcake", "cookie", "gift"]);

export function generateWorld({ pg, E, D, cm, pm, sg, seed = 1 }) {
  const rand = rng(seed);
  const between = (a, b) => a + rand() * (b - a);
  const pick = (list) => {
    const weight = (f) => (Array.isArray(f) ? f[1] : 1);
    let r = rand() * list.reduce((t, f) => t + weight(f), 0);
    for (const f of list) if ((r -= weight(f)) < 0) return Array.isArray(f) ? f[0] : f;
    return list[0];
  };
  const rect = (b, pad = 0) => ({
    x0: b.x - b.width / 2 + pad, x1: b.x + b.width / 2 - pad,
    y0: b.y - b.height / 2 + pad, y1: b.y + b.height / 2 - pad,
  });
  const B = pg.biomes;
  const areas = {
    land: rect(B.land, 150),
    arctic: rect(B.arctic, 120),
    desert: rect(B.desert, 120),
    leftOcean: rect(B.leftOcean, 120),
    rightOcean: rect(B.rightOcean, 120),
  };
  const volcano = { x: B.land.x + B.land.width * 0.22, y: B.land.y - B.land.height * 0.18, r: 520 };
  const inVolcano = (x, y, pad = 0) => Math.hypot(x - volcano.x, y - volcano.y) < volcano.r + pad;

  const out = [];
  const add = (type, species, biome, x, y, size, extra = {}) =>
    out.push({ type, species, biome: E[biome], x, y, size: Math.round(size), angle: rand() * Math.PI * 2, ...extra });
  const scatter = (area, n, fn, avoidVolcano = true) => {
    for (let i = 0; i < n; i++) {
      const x = between(area.x0, area.x1), y = between(area.y0, area.y1);
      if (avoidVolcano && inVolcano(x, y, 150)) continue;
      fn(x, y);
    }
  };

  // Volcano: the big lava mountain, lava pools on it and volcanic rocks around it.
  add("volcano", 0, "volcano", volcano.x, volcano.y, volcano.r * 2);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + rand(), d = between(120, volcano.r - 140);
    add("puddle", pm.LAVA, "land", volcano.x + Math.cos(a) * d, volcano.y + Math.sin(a) * d, between(90, 150));
  }
  for (let i = 0; i < 8; i++) {
    const a = rand() * Math.PI * 2, d = volcano.r + between(40, 160);
    add("rock", 0, "land", volcano.x + Math.cos(a) * d, volcano.y + Math.sin(a) * d, between(60, 120)); // the client has no volcano rock colour
  }

  // Land
  scatter(areas.land, 45, (x, y) => add("tree", cm.LAND, "land", x, y, between(110, 190)));
  scatter(areas.land, 20, (x, y) => add("hill", 0, "land", x, y, between(140, 240)));
  scatter(areas.land, 18, (x, y) => add("rock", 0, "land", x, y, between(70, 140)));
  scatter(areas.land, 28, (x, y) => add("bush", 0, "land", x, y, between(60, 110)));
  scatter(areas.land, 8, (x, y) => add("lake", 0, "land", x, y, between(260, 420)));
  scatter(areas.land, 10, (x, y) => add("mud", sg.LAND, "land", x, y, between(140, 240)));
  scatter(areas.land, 12, (x, y) => add("puddle", pm.LAND, "land", x, y, between(80, 140)));
  scatter(areas.land, 22, (x, y) => add("hole", 0, "land", x, y, between(40, 60)));
  // A river across the middle of the land biome, ocean to ocean.
  add("river", 0, "land", B.land.x, B.land.y + B.land.height * 0.28, B.land.width, { height: 260, angle: 0 });

  // Arctic
  scatter(areas.arctic, 22, (x, y) => add("tree", cm.ARCTIC, "arctic", x, y, between(110, 180)), false);
  scatter(areas.arctic, 12, (x, y) => add("hill", 0, "arctic", x, y, between(140, 230)), false);
  scatter(areas.arctic, 10, (x, y) => add("rock", 0, "arctic", x, y, between(70, 130)), false);
  scatter(areas.arctic, 8, (x, y) => add("puddle", pm.ARCTIC, "arctic", x, y, between(100, 180)), false);
  scatter(areas.arctic, 6, (x, y) => add("mud", sg.ARCTIC, "arctic", x, y, between(120, 200)), false);
  scatter(areas.arctic, 10, (x, y) => add("hole", 0, "arctic", x, y, between(40, 60)), false);

  // Desert
  scatter(areas.desert, 20, (x, y) => add("tree", cm.DESERT, "desert", x, y, between(110, 170)), false);
  scatter(areas.desert, 12, (x, y) => add("hill", 0, "desert", x, y, between(140, 230)), false);
  scatter(areas.desert, 14, (x, y) => add("rock", 0, "desert", x, y, between(70, 140)), false);
  scatter(areas.desert, 6, (x, y) => add("puddle", pm.DESERT, "desert", x, y, between(110, 180)), false);
  scatter(areas.desert, 6, (x, y) => add("mud", sg.DESERT, "desert", x, y, between(120, 200)), false);
  scatter(areas.desert, 10, (x, y) => add("hole", 0, "desert", x, y, between(40, 60)), false);

  // Oceans: islands with palm trees, rocks in the water.
  for (const area of [areas.leftOcean, areas.rightOcean]) {
    scatter(area, 4, (x, y) => {
      const r = between(150, 230);
      add("island", 0, "ocean", x, y, r * 2);
      add("tree", rand() < 0.5 ? cm.COCO : cm.BANANA, "ocean", x, y, between(110, 160));
    }, false);
    scatter(area, 8, (x, y) => add("rock", 0, "ocean", x, y, between(70, 130)), false);
  }

  // Flytraps (land), healing stones (around the volcano and a few on land)
  scatter(areas.land, 8, (x, y) => add("flytrap", 0, "land", x, y, between(70, 100)));
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + rand(), d = volcano.r + between(200, 320);
    add("healing_stone", 0, "land", volcano.x + Math.cos(a) * d, volcano.y + Math.sin(a) * d, between(90, 120));
  }
  scatter(areas.land, 4, (x, y) => add("healing_stone", 0, "land", x, y, between(90, 120)));
  scatter(areas.desert, 2, (x, y) => add("healing_stone", 0, "desert", x, y, between(90, 120)), false);
  scatter(areas.arctic, 2, (x, y) => add("healing_stone", 0, "arctic", x, y, between(90, 120)), false);

  // Party: a giant cake in land, desert and arctic, slingshots, and balloons tied around both.
  const balloons = (x, y, ring, n, biome) => {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + between(-0.2, 0.2);
      add("balloon", 0, biome, x + Math.cos(a) * ring, y + Math.sin(a) * ring, between(40, 55), { color: Math.floor(rand() * 256) });
    }
  };
  const cakes = [
    ["land", B.land.x + B.land.width * 0.2, B.land.y + B.land.height * 0.05],
    ["arctic", B.arctic.x - B.arctic.width * 0.2, B.arctic.y],
    ["desert", B.desert.x + B.desert.width * 0.2, B.desert.y],
  ];
  // Clear the ground under each cake first, so nothing sits on its layers.
  for (const [, x, y] of cakes)
    for (let i = out.length - 1; i >= 0; i--)
      if (out[i].type !== "river" && Math.hypot(out[i].x - x, out[i].y - y) < 260 + out[i].size / 2) out.splice(i, 1);
  for (const [biome, x, y] of cakes) {
    add("cake", 0, biome, x, y, 520);
    balloons(x, y, 300, 8, biome);
  }
  const slingshots = [
    ["land", areas.land], ["land", areas.land], ["arctic", areas.arctic], ["desert", areas.desert],
  ];
  for (const [biome, area] of slingshots)
    scatter(area, 1, (x, y) => {
      add("slingshot", 0, biome, x, y, 120);
      balloons(x, y, 110, 3, biome);
    }, biome === "land");

  // Foods
  const addFood = (name, biome, x, y) => {
    const extra = STYLED_FOODS.has(name) ? { style: 1 + Math.floor(rand() * 7) } : {};
    add("food", D[name], biome, x, y, BIG_FOODS.has(name) ? between(28, 40) : between(14, 24), extra);
  };
  const food = (biome, list, area, n, avoid = true) => scatter(area, n, (x, y) => addFood(pick(list), biome, x, y), avoid);
  food("land", FOODS.land, areas.land, 600);
  food("arctic", FOODS.arctic, areas.arctic, 240, false);
  food("desert", FOODS.desert, areas.desert, 240, false);
  food("ocean", FOODS.ocean, areas.leftOcean, 160, false);
  food("ocean", FOODS.ocean, areas.rightOcean, 160, false);
  const around = (x, y, r0, r1, n, fn) => {
    for (let i = 0; i < n; i++) {
      const a = rand() * Math.PI * 2, d = between(r0, r1);
      fn(x + Math.cos(a) * d, y + Math.sin(a) * d);
    }
  };
  around(volcano.x, volcano.y, 0, volcano.r - 40, 70, (x, y) => addFood(pick(FOODS.volcano), "volcano", x, y));
  for (const lake of out.filter((e) => e.type === "lake"))
    around(lake.x, lake.y, 0, lake.size * 0.35, 4, (x, y) => addFood(pick(FOODS.lake), "land", x, y));
  for (const [biome, x, y] of cakes) around(x, y, 300, 520, 26, (fx, fy) => addFood(pick(FOODS.party), biome, fx, fy));
  // Beehives hang by a dozen land trees, with honeycomb around them.
  for (const tree of out.filter((e) => e.type === "tree" && e.biome === E.land).slice(0, 12)) {
    const a = rand() * Math.PI * 2;
    addFood("beehive", "land", tree.x + Math.cos(a) * tree.size * 0.6, tree.y + Math.sin(a) * tree.size * 0.6);
    around(tree.x, tree.y, tree.size * 0.6, tree.size, 2, (x, y) => addFood("honeycomb", "land", x, y));
  }

  // Swamp (an area of the land biome): murky water, mud and reeds, with its own foods. Things on
  // the wire keep the land biome, which the client knows how to colour.
  const swamp = B.swamp;
  if (swamp) {
    const area = rect(swamp, 60);
    const inSwamp = (e) => Math.abs(e.x - swamp.x) < swamp.width / 2 && Math.abs(e.y - swamp.y) < swamp.height / 2;
    for (let i = out.length - 1; i >= 0; i--) if (out[i].type === "food" && inSwamp(out[i])) out.splice(i, 1);
    scatter(area, 14, (x, y) => add("mud", sg.LAND, "land", x, y, between(160, 260)), false);
    scatter(area, 16, (x, y) => add("puddle", pm.LAND, "land", x, y, between(90, 160)), false);
    scatter(area, 5, (x, y) => add("lake", 0, "land", x, y, between(220, 340)), false);
    scatter(area, 10, (x, y) => add("bush", 0, "land", x, y, between(60, 100)), false);
    scatter(area, 6, (x, y) => add("tree", cm.LAND, "land", x, y, between(110, 160)), false);
    scatter(area, 220, (x, y) => customFood(pick(CUSTOM_FOODS.swamp), "land", x, y), false);
  }

  // Tunnel entrances to the underground: two big holes in each surface biome.
  for (const [biome, area] of [["land", areas.land], ["arctic", areas.arctic], ["desert", areas.desert], ...(swamp ? [["land", rect(swamp, 200)]] : [])])
    scatter(area, 2, (x, y) => add("hole", 0, biome, x, y, 110, { portal: "underground" }), biome === "land");

  return { entities: out, volcano, areas };

  function customFood(name, biome, x, y) {
    add("food", D[name], biome, x, y, CUSTOM_BIG.has(name) ? between(28, 40) : between(16, 26));
  }
}

// A layer world (underground, sky, space): the whole map is that one biome. Terrain reuses the
// client's own objects in colours that fit (brown rocks underground, white hills as clouds in the
// sky, blue-grey rocks as asteroids in space). Holes are the portals back out.
export function generateLayerWorld({ layer, pg, E, D, cm, pm, sg, seed = 1 }) {
  const rand = rng(seed * 7 + layer.length);
  const between = (a, b) => a + rand() * (b - a);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  let w = 0, h = 0;
  for (const b of Object.values(pg.biomes)) (w = Math.max(w, b.x + b.width / 2)), (h = Math.max(h, b.y + b.height / 2));
  const out = [];
  const add = (type, species, biome, x, y, size, extra = {}) =>
    out.push({ type, species, biome: E[biome], x, y, size: Math.round(size), angle: rand() * Math.PI * 2, ...extra });
  const scatter = (n, fn, pad = 200) => {
    for (let i = 0; i < n; i++) fn(between(pad, w - pad), between(pad, h - pad));
  };
  const foods = CUSTOM_FOODS[layer] ?? [];
  const food = (n, biome) =>
    scatter(n, (x, y) => {
      const name = pick(foods);
      add("food", D[name], biome, x, y, CUSTOM_BIG.has(name) ? between(28, 40) : between(16, 26));
    });
  if (layer === "underground") {
    scatter(70, (x, y) => add("rock", 0, "desert", x, y, between(80, 200)));
    scatter(25, (x, y) => add("hill", 0, "desert", x, y, between(160, 280)));
    scatter(18, (x, y) => add("mud", sg.DESERT, "desert", x, y, between(150, 260)));
    scatter(8, (x, y) => add("lake", 0, "land", x, y, between(240, 380)));
    scatter(14, (x, y) => add("puddle", pm.LAND, "land", x, y, between(90, 150)));
    scatter(10, (x, y) => add("hole", 0, "desert", x, y, 110, { portal: "surface" }));
    food(900, "desert");
  } else if (layer === "sky") {
    scatter(60, (x, y) => add("hill", 0, "arctic", x, y, between(180, 320))); // clouds
    scatter(20, (x, y) => add("bush", 0, "arctic", x, y, between(70, 110)));
    scatter(6, (x, y) => add("lake", 0, "arctic", x, y, between(200, 320)));
    scatter(8, (x, y) => add("hole", 0, "arctic", x, y, 120, { portal: "surface" })); // gaps in the clouds
    food(900, "arctic");
  } else if (layer === "space") {
    scatter(80, (x, y) => add("rock", 0, "ocean", x, y, between(70, 220))); // asteroids
    scatter(12, (x, y) => add("puddle", pm.LAVA, "land", x, y, between(80, 140))); // little suns
    scatter(10, (x, y) => add("hole", 0, "ocean", x, y, 120, { portal: "sky" })); // wormholes
    food(900, "ocean");
  }
  return { entities: out, volcano: { x: w / 2, y: h / 2, r: 0 }, areas: {} };
}

// A world from a map recorded on mope.io (see map-recorder.js): its objects and foods as recorded.
// The volcano's position comes from its volcano object (a map without one still gets a spawn
// point for volcano animals, with no lava area).
export function worldFromRecording(map, pg) {
  const entities = map.entities.map((e) => ({ ...e }));
  const v = entities.find((e) => e.type === "volcano");
  const B = pg.biomes.land;
  return { entities, volcano: v ? { x: v.x, y: v.y, r: v.size / 2 } : { x: B.x + B.width * 0.22, y: B.y - B.height * 0.18, r: 0 } };
}
