// Generates the static world for a lobby: terrain objects and foods for every biome, laid out on
// the client's own map (pg.biomes). Every entry is { type, species, biome, x, y, size, ... } using
// the client's enums, ready for game-server.js to encode.
//
// Mope's real server decides these server-side, so the counts, sizes and food lists below are our
// own choices, picked to look like a normal Mope map.

// Seeded PRNG so each lobby's map is stable across restarts.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export const FOODS = {
  land: ["berry", "mushroom", "red_mushroom", "carrot", "pear", "nut", "raspberry", "watermelon", "melon", "orange", "mango", "banana"],
  arctic: ["cloud_berry", "nut", "berry", "mushroom"],
  desert: ["cactus", "cactus_pear", "date", "aloevera", "aloevera_leaf", "melon"],
  ocean: ["kelp", "sea_weed", "clam", "conch", "starfish", "coconut"],
  volcano: ["pepper", "flesh", "bone"],
  lake: ["lilypad", "water"],
};

export function generateWorld({ pg, E, D, cm, pm, sg, seed = 1 }) {
  const rand = rng(seed);
  const between = (a, b) => a + rand() * (b - a);
  const pick = (list) => list[Math.floor(rand() * list.length)];
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

  // Foods
  const food = (biome, list, area, n, avoid = true) =>
    scatter(area, n, (x, y) => add("food", D[pick(list)], biome, x, y, between(14, 24)), avoid);
  food("land", FOODS.land, areas.land, 260);
  food("arctic", FOODS.arctic, areas.arctic, 110, false);
  food("desert", FOODS.desert, areas.desert, 110, false);
  food("ocean", FOODS.ocean, areas.leftOcean, 70, false);
  food("ocean", FOODS.ocean, areas.rightOcean, 70, false);
  for (let i = 0; i < 40; i++) {
    const a = rand() * Math.PI * 2, d = rand() * (volcano.r - 40);
    add("food", D[pick(FOODS.volcano)], "volcano", volcano.x + Math.cos(a) * d, volcano.y + Math.sin(a) * d, between(14, 22));
  }
  for (const lake of out.filter((e) => e.type === "lake"))
    for (let i = 0; i < 3; i++) {
      const a = rand() * Math.PI * 2, d = rand() * lake.size * 0.35;
      add("food", D[pick(FOODS.lake)], "land", lake.x + Math.cos(a) * d, lake.y + Math.sin(a) * d, between(14, 20));
    }

  return { entities: out, volcano, areas };
}
