// The custom biomes (custom-biomes.json): swamp, an area of the surface map, and three layer
// worlds, underground, sky and space, each with a full tier 1-17 animal ladder and its own foods.
// Shared by the client patch (patch-client.ts), the game server and world.js.
//
// Layers are separate worlds per region. Portals between them:
//   surface tunnel (a big hole)   -> underground      underground hole -> surface
//   slingshot at (near) full pull -> sky              sky hole (a gap in the clouds) -> surface
//   sky, the top edge             -> space            space hole (a wormhole) -> sky
import fs from "node:fs";

export const CUSTOM = JSON.parse(fs.readFileSync(new URL("./custom-biomes.json", import.meta.url), "utf8"));

export const LAYERS = ["surface", ...Object.entries(CUSTOM.biomes).filter(([, b]) => b.kind === "layer").map(([id]) => id)];

// The layer an animal lives in: its biome when that is a layer, otherwise the surface.
export const layerOfBiome = (biome) => (CUSTOM.biomes[biome]?.kind === "layer" ? biome : "surface");

// Every layer world fills the whole map with its one biome (the map size stays the same).
export const layerBiomes = (map) => ({
  ...Object.fromEntries(LAYERS.slice(1).map((id) => [id, { [id]: { x: map.x / 2, y: map.y / 2, z: 1, width: map.x, height: map.y } }])),
});

export const customAnimal = (slug) => CUSTOM.animals.find((a) => a.slug === slug);
export const customFood = (slug) => CUSTOM.foods.find((f) => f.slug === slug);

// Shop skins: every animal redrawn in each "skins" palette (tools/make-biome-art.py), sold for coins.
export const CUSTOM_SKINS = CUSTOM.animals.flatMap((a) =>
  (CUSTOM.skins ?? []).map((s) => ({ id: `${a.slug}_${s.key}`, animal: a.slug, rarity: s.rarity, name: `${s.name} ${a.name}` })),
);
