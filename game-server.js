// Local game server for the patched mope.io client. server.js attaches it to its HTTP server, so
// each region in regions.js is a WebSocket lobby at ws://<host>/play/<region> with its own world.
//
// It speaks the client's binary protocol by loading the client's own codec (bit reader/writer,
// message schemas, animal table) from mope-dump/ via client-runtime.js, and mirrors the client's
// hand-written entity readers (readInitProperties / synchronize) for animals, foods and terrain.
// Entity readers that read extra fields after the shared ones get zero padding, which they read
// as "flag off" / 0, so every species and object type decodes cleanly.
//
// Gameplay: spawn, move toward the pointer, eat food for XP (food respawns), sandbox Up/Down
// upgrade menus, chat, parties (invite links), and developer commands for staff accounts
// (see dev-commands.js).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { findClientChunk, loadClient } from "./client-runtime.js";
import { REGIONS } from "./regions.js";
import { generateWorld, generateLayerWorld, worldFromRecording, STYLED_FOODS } from "./world.js";
import { CUSTOM, layerOfBiome } from "./custom-biomes.js";
import { runCommand } from "./dev-commands.js";
import { PUMPKINS, pickPumpkin, pumpkinXP } from "./pumpkins.js";
import { MAX_XP, TIER_XP } from "./limits.js";
export { MAX_XP };

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.join(ROOT, "mope-dump/site/mope.io");
const DEBUG = !!process.env.DEBUG;
const TICK_MS = 50;
const PUMPKIN_COUNT = 45;
const PUMPKIN_RESPAWN_MS = 30_000;

const client = loadClient(findClientChunk(CLIENT_DIR, "var M = zr({"));
const S = client.get("S");
S.count = 0; // the client resets this counter before each message table; do the same
const St = client.get("St");
S.count = 0;
const s_ = client.get("s_");
const [Ot, c_, gt, T, M, Lr, E, gC, pg, Le, D, cm, pm, sg, nr] =
  ["Ot", "c_", "gt", "T", "M", "Lr", "E", "gC", "pg", "Le", "D", "cm", "pm", "sg", "nr"].map((n) => client.get(n));
const Writer = client.get("lt");
const FOOD_TIERS = client.get("Ul");
const Reader = client.get("x");
const config = loadClient(findClientChunk(CLIENT_DIR, "protocolVersion:"));
export const PROTOCOL_VERSION = config.get("c").protocolVersion;
export const ROLES = nr;
for (const [i, xp] of TIER_XP.entries()) Lr[i].requiredXP = xp; // same table as the patched client
export const game = { T, M, Lr, D, E };

let accountsRef = null; // set by createGameServer, used for equipped skins
let recordsRef = null; // set by createGameServer: worldwide most-XP and pumpkin-goal records

const clientMessages = Object.fromEntries(Object.entries(s_).map(([name, s]) => [s.encoder, name]));
export const MAP = { x: 0, y: 0 };
for (const b of Object.values(pg.biomes)) {
  MAP.x = Math.max(MAP.x, b.x + b.width / 2);
  MAP.y = Math.max(MAP.y, b.y + b.height / 2);
}
const MAX_ANIMAL_SIZE = M.king_dragon.maximumSize;
const precision = (v, max, bits) => Writer.toPrecision(Math.min(max, Math.max(0, v)), max, bits);

// ---------- encoding (mirrors the client's readers) ----------

// The client's writer only grows on byte-sized writes; bit writes assume the buffer is already
// big enough (the client pre-sizes from its schemas). So start with room and trim at the end.
const newWriter = () => new Writer(1024, true);
const written = (w) => w.buffer.slice(0, w.offset);
const record = (fn) => {
  const w = newWriter();
  fn(w);
  return written(w);
};
// Ot schemas used inside `update` carry no prefix byte; top-level ones do.
export const encode = (name, data) => new Uint8Array(Ot[name].encode(data));

// createEntity record: entity type, then B.readInitProperties and the type's own fields.
function writeInit(w, e) {
  if (e.raw) {
    // Recorded from mope.io: send the record exactly as mope.io did, under our id.
    const bytes = Buffer.from(e.raw, "base64");
    bytes.writeUInt16LE(e.id, 2);
    return w.writeBuffer(new Uint8Array(bytes));
  }
  const cfg = Le[e.type];
  w.writeUint8(gC[e.type]);
  w.writeUint8(e.species); // createEntity peeks this byte, then B.readInitProperties reads it
  w.writeUint16(e.id);
  w.writeUint8(e.biome);
  if (!cfg.dynamic || cfg.dynamicallyCreated) {
    w.writeUint16(precision(e.x, MAP.x, 16));
    w.writeUint16(precision(e.y, MAP.y, 16));
    if (cfg.hasAngle) w.writeUint8(precision(e.angle ?? 0, 2 * Math.PI, 8));
  }
  if (cfg.smallSize) w.writeUint8(Math.min(255, Math.round(e.size)));
  else w.writeUint16(Math.round(e.size));
  switch (e.type) {
    case "animal":
      w.writeUint8(e.subspecies);
      w.writeUint8(e.tier);
      w.writeUint16(0); // hole id
      w.writeString(e.name);
      w.writeString(e.skin ?? "");
      w.writeUint8((e.staff ? 1 : 0) | (e.nameColor != null ? 2 : 0) | (e.hasAccount ? 4 : 0));
      if (e.nameColor != null) w.writeUint32(e.nameColor);
      break;
    case "food":
      w.writeBoolean(false); // isProjectile
      if (e.style) w.writeBits(e.style, 3); // cupcake, cookie and gift textures 1-7
      break;
    case "balloon":
      w.writeUint8(e.color ?? 0); // colour and lean
      break;
    case "river":
      w.writeUint16(e.height); // rivers carry their length and width
      break;
    case "pumpkin":
      w.writeBits(e.subspecies, 4); // 4 bits once patch-client.ts has added our variants
      break;
  }
  w.writeUint32(0); // padding for type/species-specific extras
}

// position record for an animal: 14-bit id, then B + W synchronize.
function writeAnimalSync(w, a) {
  w.writeBits(a.id, 14);
  w.writeBoolean(true); // x present
  w.writeBoolean(true); // y present
  w.writeUint16(precision(a.x, MAP.x, 16));
  w.writeUint16(precision(a.y, MAP.y, 16));
  w.writeBoolean(false); // tumbling
  w.writeBoolean(true); // angle present
  w.writeBoolean(true); // health present
  w.writeBoolean(true); // size present
  w.writeBoolean(false); // hole changed
  if (a.tier >= 15) w.writeBoolean(false); // arena wins present
  const fx = a.fx ?? NO_FX;
  for (const k of ["diving", "healing", "burning", "frozen", "bleeding", "poisoned", "stunned"]) w.writeBoolean(!!fx[k]);
  w.writeBoolean(!!fx.web); // stuck in a web
  if (fx.web) w.writeBits(0, 1); // web subspecies
  w.writeBoolean(!!fx.constricted);
  if (fx.constricted) w.writeBits(0, 3); // constrictor subspecies
  for (let i = 0; i < 4; i++) w.writeBoolean(false); // shivering, sweating, aloed, under bush
  w.writeBoolean(!!fx.ability1); // using its ability (the client plays the animal's own animation)
  w.writeBoolean(!!fx.lowResource); // low water/lava
  w.writeBoolean(!!a.flying); // flying (slingshot, flying abilities)
  if (a.skin) w.writeBoolean(false); // the client reads a boosting flag for animals with an equipped item
  w.writeBoolean(!fx.hidden); // visible (burrowed animals are hidden)
  w.writeBoolean(!!a.godMode || Date.now() < (a.immuneUntil ?? 0)); // spawn immunity
  w.writeBits(a.biomeHere, 3);
  if (fx.frozen) w.writeBits(1, 2); // frozen by a shot
  if (fx.bleeding) w.writeBoolean(false); // stink
  w.writeUint8(precision(a.angle, 2 * Math.PI, 8));
  w.writeUint8(Math.max(0, Math.min(100, Math.round(a.health ?? 100)))); // health
  w.writeUint16(precision(a.size, MAX_ANIMAL_SIZE, 16));
  if (M[T[a.species]].canClimbTree) w.writeBoolean(false); // in tree
  w.writeUint32(0); // padding for species-specific fields
}

const NO_FX = {};

// position record for a moving pumpkin: 14-bit id, B.synchronize, then the pumpkin's angle and
// size flags (Eg.synchronize).
function writePumpkinSync(w, e) {
  w.writeBits(e.id, 14);
  w.writeBoolean(true); // x present
  w.writeBoolean(true); // y present
  w.writeUint16(precision(e.x, MAP.x, 16));
  w.writeUint16(precision(e.y, MAP.y, 16));
  w.writeBoolean(false); // tumbling
  w.writeBoolean(true); // angle present
  w.writeBoolean(false); // size present
  w.writeUint8(precision(e.angle, 2 * Math.PI, 8));
}

// Distance from point (px, py) to the segment (ax, ay)-(bx, by).
function segmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// ---------- combat ----------
// Who can eat whom is the client's own rule (W.canEat): a higher tier eats animals down to about
// half its tier; ducks, snails, bees and frogs don't eat lower tiers; giraffes don't eat each
// other. Tier 15+ animals can also bite the tail of their own tier. Bites take more health the
// bigger the tier gap; health comes back slowly once you stop getting hurt.
const NO_EATING_DOWN = new Set(["duck", "baby_duck", "angry_duck", "snail", "bee", "frog"]);
const GIRAFFES = new Set(["giraffe", "momaffie", "girabie"]);
export function canEatAnimal(a, b) {
  if (a.tier > b.tier && NO_EATING_DOWN.has(a.slug)) return false;
  if (GIRAFFES.has(a.slug) && GIRAFFES.has(b.slug)) return false;
  return a.tier > b.tier && b.tier >= Math.floor((a.tier - 1) / 2 - 0.5);
}
const BITE_MS = 500; // between one animal's bites
const SPAWN_IMMUNITY_MS = 3000;
const REGEN_DELAY_MS = 4000;
const REGEN_PER_S = 3;
// The death screen's causes (the client's aC): killed by a player, by an animal, or ran dry.
export const DEATH = { ENVIRONMENT: 0, PLAYER: 1, ANIMAL: 2, RESOURCE: 3 };

// ---------- water / lava ----------
// Every animal's bar (0-100) drains slowly and faster while boosting or flying. Water animals
// refill in any water (lakes, ponds, the river, the sea); lava animals in the volcano and lava
// pools; and every food tops it up a little, water-rich ones more. Empty, you lose health.
const RESOURCE_DRAIN = 0.55; // per second
const RESOURCE_REFILL = 14;
const RESOURCE_HURT = 4; // health per second while empty
const JUICY = { water: 25, watermelon: 12, watermelon_slice: 8, melon: 10, melon_slice: 6, lilypad: 8, kelp: 6, coconut: 8, sea_weed: 5, cactus: 6, aloevera: 6 };

// Giant cake: layer edges as shares of its radius (the client's Vg.LAYERS), and per layer stood on:
// size and view gained. The king of the hill gets 3 foods' worth of XP every 5 s. Party food comes
// out around it, up to 30 at a time, from a better menu the higher anyone stands.
const CAKE_LAYERS = [1, 0.68, 0.38];
const CAKE_GROWTH = 0.12;
const CAKE_VIEW = 0.12;
const CAKE_KING_MS = 5000;
const CAKE_FOOD_MAX = 30;
const CAKE_FOODS = [
  ["cake_crumb", "cake_crumb", "cookie"],
  ["cake_crumb", "cookie", "cookie", "cupcake"],
  ["cookie", "cupcake", "cupcake", "cake_slice"],
  ["cupcake", "cake_slice", "cake_slice", "gift"],
];
// Slingshots: pull needed to fire, and the band's full stretch (the client's pad track, 130).
const SLING_MIN_PULL = 25;
const SLING_MAX_PULL = 130;

// The client's hole goal states (Tf): what a hole shows above it.
const GOAL_STATE = { DISABLED: 0, GOAL: 1, STATS: 2, TOTAL_GOALS: 3 };

// position record for a hole: 14-bit id, then ig.synchronize (B.synchronize reads nothing for
// holes, which are static with dynamicUpdates): a "goal state changed" flag and the state.
function writeHoleGoal(w, hole, { state, variant = 0, name = "", goals = 0, xp = 0 }) {
  w.writeBits(hole.id, 14);
  w.writeBoolean(true);
  w.writeBits(state, 2);
  if (state === GOAL_STATE.GOAL) w.writeBits(variant, 4); // 4 bits once the client is patched
  if (state === GOAL_STATE.STATS) {
    w.writeString(name);
    w.writeUint16(Math.min(65535, goals));
    w.writeUint32(Math.min(2 ** 32 - 1, xp));
  }
}

// position record for a slingshot ($g.synchronize): 14-bit id, "changed", then either the loaded
// animal's id, or (unloaded) whether it was fired, which shows the launch on the client.
function writeSlingshot(w, sling, { loaded = null, fired = false }) {
  w.writeBits(sling.id, 14);
  w.writeBoolean(true);
  w.writeBoolean(!!loaded);
  if (loaded) w.writeBits(loaded.id, 14);
  else w.writeBoolean(fired);
}

// update message: groups of [u16 65535 - kind][u16 count] + length-prefixed records
function updateMessage(groups) {
  const w = newWriter();
  w.writeUint8(St.update.encoder);
  for (const [kind, records] of groups) {
    if (!records.length) continue;
    w.writeUint16(65535 - gt[kind]);
    w.writeUint16(records.length);
    for (const rec of records) {
      const bytes = rec instanceof Uint8Array ? rec : new Uint8Array(rec);
      if (bytes.byteLength >= 255) {
        w.writeUint8(255);
        w.writeUint16(bytes.byteLength);
      } else w.writeUint8(bytes.byteLength);
      w.writeBuffer(bytes);
    }
  }
  return written(w);
}

// ---------- maps recorded from mope.io ----------
// The recorder (map-recorder.js) saves every createEntity record mope.io's server sends while you
// explore. Static objects and foods are kept, decoded enough for our game logic (holes, terrain,
// the volcano), and replayed to clients byte for byte.

let recordedMap = null; // { entities, ... } from data/map.json, or null for generated worlds
const SKIP_RECORDED = new Set(["animal", "ability", "pumpkin", "arena", "sandbox_arena", "flytrap_head", "snowball", "dust_cloud"]);
const SKIP_FOODS = new Set(["carcass", "coin", "gem"]); // left behind by players, not part of the map

export const recorderInfo = () => ({
  update: St.update.encoder,
  createGroup: 65535 - gt.createEntity,
  protocol: PROTOCOL_VERSION,
  skipTypes: [...SKIP_RECORDED].map((t) => gC[t]),
  typeNames: Object.fromEntries(Object.keys(Le).map((t) => [gC[t], t])),
});

function decodeRecord(bytes) {
  const r = new Reader(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), false);
  const type = gC[r.readUint8()];
  const cfg = Le[type];
  if (!cfg) return null;
  const e = { type, species: r.readUint8() };
  r.readUint16(); // mope.io's id
  e.biome = r.readUint8();
  if (!cfg.dynamic || cfg.dynamicallyCreated) {
    e.x = Reader.fromPrecision(r.readUint16(), MAP.x, 16);
    e.y = Reader.fromPrecision(r.readUint16(), MAP.y, 16);
    if (cfg.hasAngle) e.angle = Reader.fromPrecision(r.readUint8(), 2 * Math.PI, 8);
  }
  e.size = cfg.smallSize ? r.readUint8() : r.readUint16();
  if (type === "river") e.height = r.readUint16();
  return e;
}

// capture: the recorder's file, { format, protocol, records: { id: base64 } }
export function decodeCapture(capture) {
  if (capture?.format !== "silver-frontier-map-capture" || typeof capture.records !== "object")
    throw new Error("not a map recorder file");
  const entities = [];
  const counts = {};
  for (const raw of Object.values(capture.records)) {
    let e;
    try { e = decodeRecord(Buffer.from(String(raw), "base64")); } catch { continue; }
    if (!e || SKIP_RECORDED.has(e.type) || e.x === undefined) continue;
    if (e.type === "food" && SKIP_FOODS.has(D[e.species])) continue;
    e.raw = raw;
    entities.push(e);
    const key = e.type === "food" ? `food:${D[e.species]}` : e.type;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  if (!entities.some((e) => e.type !== "food")) throw new Error("the file has no map objects in it");
  return {
    recordedAt: capture.recordedAt ?? null, protocol: capture.protocol ?? null,
    protocolMatches: capture.protocol == null || capture.protocol === PROTOCOL_VERSION, counts, entities,
  };
}

// ---------- lobby ----------

// The client only knows how to colour its own five biomes, so the custom ones (swamp, the layers)
// travel as land.
const wireBiome = (name) => (E[name] !== undefined && E[name] <= E.volcano ? E[name] : E.land);
// Layer switches ride on a serverMessage the patched client intercepts (__cbLayerMessage).
const LAYER_MESSAGE = "\u0001layer:";

function biomeAt(x, y) {
  const b = pg.biomes;
  const inside = (r) => Math.abs(x - r.x) <= r.width / 2 && Math.abs(y - r.y) <= r.height / 2;
  if (inside(b.arctic)) return "arctic";
  if (inside(b.desert)) return "desert";
  if (inside(b.leftOcean) || inside(b.rightOcean)) return "ocean";
  return "land";
}

export class Lobby {
  constructor(region, { mode = "FFA", party = null, layer = "surface", base = null } = {}) {
    this.region = region;
    this.mode = mode;
    this.party = party; // party code for private party lobbies
    this.layer = layer; // "surface", or a layer world: underground, sky, space (custom-biomes.js)
    this.base = base; // a layer world's surface lobby
    this.layers = new Map(); // a surface lobby's layer worlds, made when first entered
    this.players = new Set();
    this.nextId = 1;
    this.freeIds = []; // ids of removed entities, reused so ids stay small (animals sync 14-bit ids)
    this.entities = new Map(); // world objects and foods, by id
    this.moving = new Set(); // shot or kicked pumpkins still rolling
    this.goalShows = new Map(); // hole id -> goal display being shown
    this.seed = [...(party ?? region.id) + (layer === "surface" ? "" : layer)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
    this.rand = (() => { let x = this.seed; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32); })();
    this.buildWorld();
    this.ticks = 0;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  // A pumpkin somewhere on land, arctic or desert, with a variant picked by spawn chance.
  spawnPumpkin(announce = true, variant = pickPumpkin(), at) {
    const b = pg.biomes;
    const area = at ? null : [b.land, b.land, b.land, b.arctic, b.desert][Math.floor(this.rand() * 5)];
    const x = at?.x ?? area.x + (this.rand() - 0.5) * (area.width - 300);
    const y = at?.y ?? area.y + (this.rand() - 0.5) * (area.height - 300);
    return this.addEntity({
      type: "pumpkin", species: 0, subspecies: variant, biome: E[this.biomeAt(x, y)], x, y, size: 60, angle: this.rand() * Math.PI * 2,
    }, announce);
  }

  // Minimap markers for the rare pumpkins (gold and up), like mope.io shows them.
  minimapRecord() {
    const rare = [...this.entities.values()].filter((e) => e.type === "pumpkin" && e.subspecies >= 2).slice(0, 255);
    return record((w) => {
      w.writeUint8(rare.length);
      for (const e of rare) {
        w.writeUint16(e.id);
        w.writeBoolean(true, true); // read as a whole byte
        w.writeUint16(precision(e.x, MAP.x, 16));
        w.writeUint16(precision(e.y, MAP.y, 16));
        w.writeUint8(e.subspecies);
      }
    });
  }

  // The map recorded from mope.io (data/map.json) when there is one, otherwise a generated world.
  buildWorld() {
    const { entities, volcano } =
      this.layer !== "surface" ? generateLayerWorld({ layer: this.layer, pg, E, D, cm, pm, sg, seed: this.seed })
      : recordedMap ? worldFromRecording(recordedMap, pg)
      : generateWorld({ pg, E, D, cm, pm, sg, seed: this.seed });
    this.volcano = volcano;
    for (const e of entities) this.addEntity(e, false);
    this.holes = entities.filter((e) => e.type === "hole");
    this.cakes = entities.filter((e) => e.type === "cake");
    this.lavaPools = entities.filter((e) => e.type === "puddle" && e.species === pm.LAVA);
    this.slingshots = entities.filter((e) => e.type === "slingshot");
    this.terrainZones = entities
      .filter((e) => ["island", "mud", "lake", "puddle", "river"].includes(e.type) && !(e.type === "puddle" && e.species === pm.LAVA))
      .sort((a, b) => (a.type === "island" ? -1 : 0) - (b.type === "island" ? -1 : 0)); // islands win over sea
    if (this.layer === "surface") for (let i = 0; i < PUMPKIN_COUNT; i++) this.spawnPumpkin(false);
  }

  // ---------- layer worlds ----------

  layerLobby(layer) {
    let l = this.layers.get(layer);
    if (!l) this.layers.set(layer, (l = new Lobby(this.region, { mode: this.mode, party: this.party, layer, base: this })));
    return l;
  }

  // Players here and in this surface lobby's layer worlds.
  get occupancy() {
    return this.players.size + [...this.layers.values()].reduce((n, l) => n + l.players.size, 0);
  }

  biomeAt(x, y) {
    return this.layer === "surface" ? biomeAt(x, y) : "land";
  }

  // Moves a player to another layer of this region (or party): clears the old world from their
  // screen, switches the client's map, sends the new world, and brings their animal along, or
  // spawns `slug` there. Returns the lobby they are now in.
  transfer(p, layer, { slug, subspecies, at } = {}) {
    const base = this.base ?? this;
    const to = layer === "surface" ? base : base.layerLobby(layer);
    const prev = p.animal;
    slug ??= prev?.slug;
    subspecies ??= prev?.subspecies ?? 0;
    const kept = prev && { godMode: prev.godMode, speed: prev.speed };
    this.unloadSlingshot(p);
    p.flight = null;
    p.cake = null;
    p.cakeLayer = 0;
    this.players.delete(p);
    const gone = [...this.entities.keys(), ...[...this.players].filter((o) => o.animal).map((o) => o.animal.id)];
    if (prev) {
      this.broadcast(updateMessage([["destroyEntity", [encode("destroyEntity", { hasKiller: false, id: prev.id })]]]));
      this.freeIds.push(prev.id);
      gone.push(prev.id);
    }
    for (let i = 0; i < gone.length; i += 400)
      p.ws.send(updateMessage([["destroyEntity", gone.slice(i, i + 400).map((id) => encode("destroyEntity", { hasKiller: false, id }))]]));
    p.animal = null;
    p.lobby = to;
    to.players.add(p);
    to.serverMessage(p, LAYER_MESSAGE + layer);
    to.sendWorld(p);
    if (slug) {
      to.spawn(p, slug, subspecies, { at, redirect: false });
      if (kept) Object.assign(p.animal, kept);
    }
    p.portalReadyAt = Date.now() + 2500;
    to.serverMessage(p, layer === "surface" ? "Back on the surface." : layer === "space" ? "Welcome to Space!" : `Welcome to the ${CUSTOM.biomes[layer].name}!`);
    return to;
  }

  // Portals: tunnel holes, the sky's top edge. True when the player has left this lobby.
  portalStep(p, now) {
    if (now < (p.portalReadyAt ?? 0)) return false;
    const a = p.animal;
    for (const h of this.holes)
      if (h.portal && Math.hypot(a.x - h.x, a.y - h.y) < h.size / 2) {
        this.transfer(p, h.portal, { at: { x: Math.min(MAP.x - 100, a.x + 180), y: a.y } });
        return true;
      }
    if (this.layer === "sky" && a.y < 220) {
      this.transfer(p, "space", { at: { x: a.x, y: MAP.y - 400 } });
      return true;
    }
    return false;
  }

  // Swaps in a new map for everyone here: clears the old world from their screens, then sends
  // the new one. Animals stay where they are.
  rebuildWorld() {
    const gone = [...this.entities.keys()];
    this.entities.clear();
    this.moving.clear();
    this.goalShows.clear();
    for (const p of this.players)
      for (let i = 0; i < gone.length; i += 400)
        p.ws.send(updateMessage([["destroyEntity", gone.slice(i, i + 400).map((id) => encode("destroyEntity", { hasKiller: false, id }))]]));
    this.freeIds.push(...gone);
    this.buildWorld();
    const records = [...this.entities.values()].map((e) => record((w) => writeInit(w, e)));
    for (let i = 0; i < records.length; i += 400) this.broadcast(updateMessage([["createEntity", records.slice(i, i + 400)]]));
  }

  allocId() {
    return this.freeIds.pop() ?? this.nextId++;
  }

  get playerCount() {
    return [...this.players].filter((p) => p.animal).length;
  }

  addEntity(e, announce = true) {
    e.id = this.allocId();
    this.entities.set(e.id, e);
    if (announce) this.broadcast(updateMessage([["createEntity", [record((w) => writeInit(w, e))]]]));
    return e;
  }

  removeEntity(id) {
    if (!this.entities.delete(id)) return false;
    this.freeIds.push(id);
    this.broadcast(updateMessage([["destroyEntity", [encode("destroyEntity", { hasKiller: false, id })]]]));
    return true;
  }

  broadcast(bytes, except) {
    for (const p of this.players) if (p !== except && p.ws.readyState === 1) p.ws.send(bytes);
  }

  // Sends the whole world to a newly connected client, in chunks.
  sendWorld(p) {
    const records = [...this.entities.values()].map((e) => record((w) => writeInit(w, e)));
    for (const o of this.players) if (o.animal && o !== p) records.push(record((w) => writeInit(w, o.animal)));
    for (let i = 0; i < records.length; i += 400)
      p.ws.send(updateMessage([["createEntity", records.slice(i, i + 400)]]));
  }

  makeAnimal(p, slug, subspecies = 0, at) {
    const cfg = M[slug];
    const home = cfg.animalResource?.type === 1 ? "volcano" : cfg.biome;
    const custom = CUSTOM.biomes[home];
    const spawn = at ?? (home === "volcano" ? this.volcano
      : home === "ocean" ? pg.biomes.leftOcean
      : custom?.kind === "layer" ? { x: MAP.x / 2 + (this.rand() - 0.5) * 2000, y: MAP.y / 2 + (this.rand() - 0.5) * 2000 }
      : pg.biomes[home] ?? pg.biomes.land);
    return {
      type: "animal",
      id: p.animal?.id ?? this.allocId(),
      slug, subspecies,
      species: T[slug],
      tier: Lr.findIndex((t) => t.animals.includes(T[slug])) + 1,
      biome: wireBiome(home),
      biomeHere: wireBiome(home),
      size: cfg.minimumSize,
      x: spawn.x, y: spawn.y, angle: 0,
      name: p.name,
      skin: p.skinOverride ?? accountsRef?.equippedSkin(p.account, slug) ?? "",
      staff: p.role >= nr.MODERATOR,
      hasAccount: !!p.account,
      godMode: p.animal?.godMode ?? false,
      speed: p.animal?.speed ?? 1,
      health: 100,
      resource: p.animal?.resource ?? 100,
      immuneUntil: p.animal?.immuneUntil ?? 0,
    };
  }

  // `redirect`: an animal from another layer's biome is spawned in that layer (picking a sky
  // animal takes you to the sky); portals turn it off to bring any animal along.
  spawn(p, slug, subspecies = 0, { at = null, redirect = true } = {}) {
    const layer = layerOfBiome(M[slug].biome);
    if (redirect && layer !== this.layer) return this.transfer(p, layer, { slug, subspecies });
    const prev = p.animal;
    this.unloadSlingshot(p);
    p.flight = null;
    p.animal = this.makeAnimal(p, slug, subspecies, at ?? (prev && { x: prev.x, y: prev.y }));
    p.target = { x: p.animal.x, y: p.animal.y };
    p.animal.size = this.targetSize(p); // a new animal starts at the size its XP calls for
    this.broadcast(
      updateMessage([
        ["createEntity", [record((w) => writeInit(w, p.animal))]],
        ["position", [record((w) => writeAnimalSync(w, p.animal))]],
      ]),
    );
    p.ws.send(encode("startGameSession", { id: p.animal.id }));
    this.sendXP(p);
  }

  // Removes the player's animal. `stats` sends the death screen; `death` ({ cause, killer }) fills
  // in who or what did it, and the client shows the killer eating the animal.
  despawn(p, stats = true, death = null) {
    if (!p.animal) return;
    this.unloadSlingshot(p);
    p.flight = null;
    const id = p.animal.id;
    p.animal = null;
    this.freeIds.push(id);
    const killer = death?.killer?.animal;
    this.broadcast(updateMessage([["destroyEntity", [encode("destroyEntity", { hasKiller: !!killer, id, killer: killer?.id ?? 0 })]]]));
    if (stats)
      p.ws.send(encode("stopGameSession", {
        xp: Math.min(MAX_XP, p.xp), timeAlive: Math.round((Date.now() - (p.spawnedAt ?? Date.now())) / 1000), kills: p.kills ?? 0, wins: p.wins ?? 0,
        coinsEarned: 0, cause: death?.cause ?? DEATH.ENVIRONMENT,
        killerName: killer ? death.killer.name || "Unnamed" : "", killerAnimal: killer?.species ?? 0, killerSubspecies: killer?.subspecies ?? 0,
        killerSkin: killer?.skin ?? "", via: 0, viaId: 0, castByName: "", castByAnimal: 0,
      }));
  }

  // ---------- combat ----------

  // Whether p's animal can be hurt by q's (q null for the environment) right now.
  canHurt(p, q, now) {
    const b = p.animal, a = q?.animal;
    if (!b || b.godMode || now < (b.immuneUntil ?? 0) || b.flying || b.fx?.hidden || b.fx?.shell) return false;
    if (!q) return true;
    if (!a || a === b || a.flying || a.fx?.hidden) return false;
    if (!!a.fx?.diving !== !!b.fx?.diving) return false; // divers only meet divers
    if (this.mode === "SANDBOX") return false;
    if (this.mode === "TEAMS" && p.team && p.team === q.team) return false;
    if ((p.arena ?? null) !== (q.arena ?? null)) return false; // 1v1s are private
    return true;
  }

  // Contact bites, every tick: predators bite prey they touch; tier 15+ bite same-tier tails.
  combatStep(now) {
    const fighters = [...this.players].filter((p) => p.animal && !p.animal.flying);
    for (const q of fighters)
      for (const p of fighters) {
        const a = q.animal, b = p.animal;
        if (!a || !b || a === b || now < (a.biteReadyAt ?? 0) || (a.fx?.stunned)) continue;
        if (Math.hypot(a.x - b.x, a.y - b.y) > (a.size + b.size) / 2) continue;
        let damage = 0;
        if (canEatAnimal(a, b)) damage = Math.min(40, 12 + 4 * (a.tier - b.tier));
        else if (a.tier >= 15 && a.tier === b.tier) {
          const behind = Math.cos(b.angle) * (a.x - b.x) + Math.sin(b.angle) * (a.y - b.y) < 0;
          if (behind) damage = 10;
        }
        if (!damage || !this.canHurt(p, q, now)) continue;
        a.biteReadyAt = now + BITE_MS;
        this.hurt(p, damage, q, now);
      }
  }

  // Takes health from p (by q, or null for the environment). Knocks it back from its attacker.
  hurt(p, damage, q, now, cause = q ? DEATH.PLAYER : DEATH.ENVIRONMENT) {
    const b = p.animal;
    if (!b || (q && !this.canHurt(p, q, now)) || (!q && (b.godMode || now < (b.immuneUntil ?? 0)))) return;
    b.health = (b.health ?? 100) - damage * (b.shieldMultiplier ?? 1);
    b.hurtAt = now;
    const a = q?.animal;
    if (a) {
      const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      b.x = Math.min(MAP.x, Math.max(0, b.x + ((b.x - a.x) / d) * 30));
      b.y = Math.min(MAP.y, Math.max(0, b.y + ((b.y - a.y) / d) * 30));
    }
    if (b.health <= 0) this.kill(p, q, cause);
  }

  // p's animal dies. The killer gains a quarter of its XP (at least five foods' worth); it drops
  // meat that anyone can eat for a minute.
  kill(p, q, cause = DEATH.PLAYER) {
    const b = p.animal;
    if (!b) return;
    const a = q?.animal;
    if (a) {
      const gain = Math.max(this.foodXP(a) * 5, Math.round(p.xp * 0.25));
      q.xp += gain;
      q.kills = (q.kills ?? 0) + 1;
      this.sendXP(q);
      this.checkProgress(q);
      this.serverMessage(q, `You ate ${p.name || "a player"}! +${gain.toLocaleString("en-US")} XP`);
    }
    const meat = 2 + Math.floor(b.tier / 3);
    for (let i = 0; i < meat; i++) {
      const t = (i / meat) * Math.PI * 2, r = b.size * 0.4;
      const e = this.addEntity({
        type: "food", species: D.flesh, biome: b.biomeHere, x: b.x + Math.cos(t) * r, y: b.y + Math.sin(t) * r,
        size: 18 + Math.min(20, b.tier), angle: t, fromKill: true,
      });
      setTimeout(() => this.timer && this.entities.get(e.id) === e && this.removeEntity(e.id), 60_000);
    }
    this.onDeath?.(p, q);
    this.despawn(p, true, { cause, killer: a ? q : null });
  }

  // Health back over time, the water/lava bar, and the timed status effects.
  vitalsStep(p, dt, now) {
    const a = p.animal;
    if (now - (a.hurtAt ?? 0) > REGEN_DELAY_MS && a.health < 100) a.health = Math.min(100, a.health + REGEN_PER_S * dt);
    const cfg = this.configOf(a);
    const type = cfg.animalResource?.type ?? 0;
    const custom = CUSTOM.biomes[cfg.biome];
    let rate = -RESOURCE_DRAIN * (a.boostUntil > now ? 3 : 1) * (a.flying ? 2 : 1) * (this.layer === "space" ? 0.5 : 1);
    if (type === 0 && this.terrainAt(a.x, a.y) === "water") rate = RESOURCE_REFILL;
    if (type === 1 && this.inLava(a.x, a.y)) rate = RESOURCE_REFILL;
    if (custom && this.layer !== "surface" && type === 0 && this.terrainAt(a.x, a.y) !== "water") rate *= 0.6;
    a.resource = Math.max(0, Math.min(100, (a.resource ?? 100) + rate * dt));
    const shown = Math.round(a.resource);
    if (shown !== p.shownResource) {
      p.shownResource = shown;
      p.ws.send(updateMessage([["resource", [encode("resource", { resource: shown })]]]));
    }
    if (a.resource <= 0) this.hurt(p, RESOURCE_HURT * dt, null, now, DEATH.RESOURCE);
    if (!p.animal) return;
    // status effects that run out on their own (abilities set the *Until times)
    const fx = (a.fx ??= {});
    for (const k of ["stunned", "poisoned", "burning", "frozen", "bleeding", "healing", "web", "constricted"]) fx[k] = now < (a[k + "Until"] ?? 0);
    fx.lowResource = a.resource < 25;
    if (fx.poisoned) this.hurt(p, 5 * dt, a.poisonedBy ?? null, now);
    if (p.animal && fx.burning) this.hurt(p, 8 * dt, a.burningBy ?? null, now);
    if (p.animal && fx.bleeding) this.hurt(p, 3 * dt, a.bleedingBy ?? null, now);
    if (p.animal && fx.healing) a.health = Math.min(100, a.health + 10 * dt);
  }

  inLava(x, y) {
    if (this.volcano.r && Math.hypot(x - this.volcano.x, y - this.volcano.y) < this.volcano.r) return true;
    return this.lavaPools.some((e) => Math.hypot(x - e.x, y - e.y) < e.size / 2);
  }

  sendXP(p) {
    p.xp = Math.min(MAX_XP, Math.max(0, Math.round(p.xp)));
    p.ws.send(updateMessage([["xp", [encode("xp", { xp: p.xp, rank: this.rankOf(p) })]]]));
    if (p.animal && p.xp > 0) recordsRef?.recordXP(p);
  }

  // Players in this lobby by XP, highest first.
  standings() {
    return [...this.players].filter((o) => o.animal).sort((a, b) => b.xp - a.xp);
  }

  rankOf(p) {
    return Math.min(65535, this.standings().indexOf(p) + 1 || 1);
  }

  // In-game leaderboard: the top 10 of this lobby, [u16 entity id][f64 XP] each; the client
  // patch reads the XP as 64 bits so scores past 4.29B show. Empty slots are id 0.
  leaderboardRecord() {
    const top = this.standings().slice(0, 10);
    return record((w) => {
      for (let i = 0; i < 10; i++) {
        w.writeUint16(top[i]?.animal.id ?? 0);
        w.writeFloat64(top[i]?.xp ?? 0);
      }
    });
  }

  // serverMessage has no prefix byte in the client's schema: it travels inside an update.
  serverMessage(p, message) {
    p.ws.send(updateMessage([["serverMessage", [encode("serverMessage", { message, translate: false })]]]));
  }

  // Upgrade menu: every animal of the chosen tier. `sandbox` marks menus opened by the
  // Up/Down buttons and keys rather than by earning XP.
  showTier(p, tier, sandbox = true) {
    p.menuSandbox = sandbox;
    p.menuTier = Math.min(Lr.length, Math.max(1, tier));
    p.menu = Lr[p.menuTier - 1].animals.map((species) => T[species]);
    p.ws.send(encode("upgradeMenu", {
      animals: p.menu.map((slug) => T[slug]),
      subspecies: p.menu.map(() => 0),
      equippedItemIds: p.menu.map((slug) => accountsRef?.equippedSkin(p.account, slug) ?? ""),
    }));
  }

  // An animal's size range, using its form's own range when the client defines one.
  sizeRange(a) {
    const cfg = M[a.slug];
    const form = cfg.subspeciesOverrides?.get?.(a.subspecies) ?? {};
    return [form.minimumSize ?? cfg.minimumSize, form.maximumSize ?? cfg.maximumSize];
  }

  // XP at which a tier's animal reaches full size: 10 trillion for tier 17, halving for each
  // tier below (tier 16 = 5T, tier 15 = 2.5T, ... tier 1 = about 153M).
  growthCap(tier) {
    return MAX_XP / 2 ** (Lr.length - tier);
  }

  // Size, between the animal's (or its form's) minimum and maximum:
  //  - tiers 1-16: minimum at the tier's XP requirement, 75% of the range at the next tier's
  //    requirement (normal play upgrades about here), then on up to the maximum at the tier's
  //    growth cap on a log scale (every ×10 in XP adds the same amount of size)
  //  - tier 17: minimum at its requirement (1T), maximum at 10 trillion, on a log scale
  // Losing XP shrinks it again; /size pins it instead.
  targetSize(p) {
    const a = p.animal;
    if (p.fixedSize) return p.fixedSize;
    const [min, max] = this.sizeRange(a);
    const from = Lr[a.tier - 1].requiredXP;
    const next = Lr[a.tier]?.requiredXP;
    const cap = this.growthCap(a.tier);
    const logShare = (lo, hi) => (p.xp <= lo ? 0 : Math.log(p.xp / lo) / Math.log(hi / lo));
    let progress;
    if (next === undefined) progress = logShare(from, cap);
    else if (p.xp < next) progress = 0.75 * ((p.xp - from) / (next - from));
    else progress = 0.75 + 0.25 * logShare(next, cap);
    return min + (max - min) * Math.min(1, Math.max(0, progress));
  }

  // Highest tier (1-17) the player's XP has reached, from the client's own XP table (Lr[i] is
  // tier i+1's requirement).
  earnedTier(p) {
    let tier = 1;
    while (tier < Lr.length && p.xp >= Lr[tier].requiredXP) tier++;
    return tier;
  }

  // The animal's config with its form's overrides applied (the client's Vr()).
  configOf(a) {
    const base = M[a.slug];
    const form = base.subspeciesOverrides?.get?.(a.subspecies);
    return form ? { ...base, ...form } : base;
  }

  // Terrain under a point, in the client's terms (terrainSpeedComfort: land, water, mud).
  terrainAt(x, y) {
    for (const e of this.terrainZones) {
      if (e.type === "river") {
        if (Math.abs(x - e.x) <= e.size / 2 && Math.abs(y - e.y) <= e.height / 2) return "water";
      } else if (Math.hypot(x - e.x, y - e.y) <= e.size / 2) {
        if (e.type === "island") return "land";
        return e.type === "mud" ? "mud" : "water";
      }
    }
    return this.biomeAt(x, y) === "ocean" ? "water" : "land";
  }

  // Movement, from the client's own animal data:
  //  - speed scales with how far the pointer is (the touch joystick sends a point up to 300 away)
  //  - terrainSpeedComfort[land|water|mud] multiplies it (out-of-comfort terrain is slower)
  //  - on arctic ground, animals with iceGrip < 1 slide: velocity follows the input only by iceGrip
  //  - boost (Space / click) dashes, then waits boostCooldown
  // mope.io's absolute base speed is server-side; ours slows a little with tier.
  move(p, dt) {
    const a = p.animal;
    const cfg = this.configOf(a);
    const terrain = this.terrainAt(a.x, a.y);
    const now = Date.now();
    const dx = p.target.x - a.x, dy = p.target.y - a.y, dist = Math.hypot(dx, dy);
    const base = (360 - a.tier * 8) * a.speed * (cfg.terrainSpeedComfort?.[terrain] ?? 1);
    let want = dist > 5 && !p.movementLocked ? base * Math.min(1, dist / 250) : 0;
    if (a.boostUntil > now) want = base * 2.2;
    const dirX = dist > 0 ? dx / dist : Math.cos(a.angle), dirY = dist > 0 ? dy / dist : Math.sin(a.angle);
    const onIce = a.biomeHere === E.arctic && terrain === "land" && (cfg.iceGrip ?? 0.15) < 1;
    const grip = onIce ? Math.max(0.04, cfg.iceGrip ?? 0.15) : 0.35;
    a.vx = (a.vx ?? 0) + (dirX * want - (a.vx ?? 0)) * grip;
    a.vy = (a.vy ?? 0) + (dirY * want - (a.vy ?? 0)) * grip;
    const moved = Math.hypot(a.vx, a.vy) * dt;
    if (moved < 0.05) return;
    a.x = Math.min(MAP.x, Math.max(0, a.x + a.vx * dt));
    a.y = Math.min(MAP.y, Math.max(0, a.y + a.vy * dt));
    // the client's angle is the facing direction on screen (0 = right, clockwise, y down)
    if (Math.hypot(a.vx, a.vy) > 15) a.angle = (Math.atan2(a.vy, a.vx) + 2 * Math.PI) % (2 * Math.PI);
    a.biomeHere = Math.hypot(a.x - this.volcano.x, a.y - this.volcano.y) < this.volcano.r ? E.volcano : E[this.biomeAt(a.x, a.y)];
    this.eat(p);
  }

  boost(p) {
    const a = p.animal;
    const now = Date.now();
    if (!a || now < (a.boostReadyAt ?? 0)) return;
    a.boostUntil = now + 300;
    a.boostReadyAt = now + (this.configOf(a).boostCooldown ?? 1500);
  }

  // Natural progression: once XP reaches the next tier, offer that tier's animals, all the way
  // to tier 17. One tier per menu, like mope.io; the next menu follows the pick if XP allows.
  // After a sandbox pick (Up/Down buttons, /animal) this waits until XP passes a tier above the
  // one XP had already reached, so a downgrade with lots of XP doesn't reopen the menu at once.
  checkProgress(p) {
    if (!p.animal || p.menu.length) return;
    const earned = this.earnedTier(p);
    if (earned > p.animal.tier && earned > (p.autoFloor ?? 0)) this.showTier(p, p.animal.tier + 1, false);
  }

  // Changes the player's animal. Moving to a higher tier than XP has reached raises XP to that
  // tier's requirement, so the XP bar and size match the animal; moving down keeps XP.
  switchAnimal(p, slug, subspecies = 0, sandbox = true) {
    const tier = Lr.findIndex((t) => t.animals.includes(T[slug])) + 1;
    p.xp = Math.max(p.xp, Lr[tier - 1].requiredXP);
    this.spawn(p, slug, subspecies);
    p.autoFloor = sandbox ? this.earnedTier(p) : 0;
    this.checkProgress(p);
  }

  // Food is worth about 1/30 of the gap to the next tier, so every tier takes a similar effort.
  // At tier 17 it's 1/300 of the way to the XP cap.
  foodXP(a) {
    const next = Lr[a.tier]?.requiredXP;
    if (next === undefined) return Math.round((MAX_XP - Lr[a.tier - 1].requiredXP) / 300);
    return Math.max(25, Math.round((next - Lr[a.tier - 1].requiredXP) / 30));
  }

  eat(p) {
    const a = p.animal;
    for (const e of this.entities.values()) {
      if (e.type === "pumpkin") {
        // Pumpkins aren't food: touching one pushes it so it rolls, boosting kicks it hard.
        if (Math.hypot(e.x - a.x, e.y - a.y) <= a.size / 2 + e.size / 2) this.kickPumpkin(p, e);
        continue;
      }
      if (e.type !== "food") continue;
      if (Math.hypot(e.x - a.x, e.y - a.y) > a.size / 2 + e.size / 2) continue;
      const range = FOOD_TIERS[D[e.species]]; // the client's own table of which tiers eat what
      if (range && (a.tier < range.minimumTier || a.tier > range.maximumTier)) continue;
      this.removeEntity(e.id);
      p.xp += this.foodXP(a);
      a.resource = Math.min(100, (a.resource ?? 100) + (JUICY[D[e.species]] ?? 2) + (CUSTOM.biomes[this.configOf(a).biome] ? 4 : 0));
      this.sendXP(p);
      this.checkProgress(p);
      if (e.fromCake || e.fromKill) continue; // put out by a cake (which makes more), or meat from a kill
      const { id, ...food } = e;
      setTimeout(() => this.timer && this.addEntity(food), 8000);
    }
  }

  // Fires a pumpkin from the front of the player's animal in the direction it faces. It rolls,
  // slows down and stops, then rolls again when pushed. Animals it hits fast are knocked back.
  shootPumpkin(p, variant, spread = 0) {
    const a = p.animal;
    const dir = a.angle + spread; // the client's angle is the facing direction
    const start = a.size / 2 + 40;
    const e = this.spawnPumpkin(true, variant, { x: a.x + Math.cos(dir) * start, y: a.y + Math.sin(dir) * start });
    Object.assign(e, { vx: Math.cos(dir) * 1400, vy: Math.sin(dir) * 1400, shooter: p, angle: dir, shot: true, kicked: Date.now() });
    this.moving.add(e);
    if (DEBUG) console.log(`shoot from ${Math.round(a.x)},${Math.round(a.y)} angle ${(dir * 180 / Math.PI).toFixed(1)}°`);
    return e;
  }

  // Rolls a pumpkin away from the animal touching it: as fast as the animal is moving (a bit
  // more, so it rolls ahead), or a hard kick while boosting. It's moved out to touching distance
  // so it never sits inside the animal. Whoever touched it last gets the goal.
  kickPumpkin(p, e) {
    const a = p.animal;
    const dir = Math.atan2(e.y - a.y, e.x - a.x);
    const reach = a.size / 2 + e.size / 2 + 1;
    e.x = Math.min(MAP.x, Math.max(0, a.x + Math.cos(dir) * reach));
    e.y = Math.min(MAP.y, Math.max(0, a.y + Math.sin(dir) * reach));
    const pushing = Math.max(0, (a.vx ?? 0) * Math.cos(dir) + (a.vy ?? 0) * Math.sin(dir));
    const speed = a.boostUntil > Date.now() ? 1200 : Math.max(250, pushing * 1.8);
    if (Math.hypot(e.vx ?? 0, e.vy ?? 0) > speed && this.moving.has(e)) return; // already rolling faster
    Object.assign(e, { vx: Math.cos(dir) * speed, vy: Math.sin(dir) * speed, shooter: p, kicked: Date.now() });
    this.moving.add(e);
  }

  // A kicked or shot pumpkin that rolls into a hole is a goal for whoever sent it: the pumpkin's
  // XP as a bonus, +1 to their worldwide goal count, and the hole shows the client's own
  // "GOAAAAL!!!" ring, then the scorer's stats.
  scoreGoal(e, hole) {
    const p = e.shooter;
    this.removeEntity(e.id);
    if (!e.shot) setTimeout(() => this.timer && this.spawnPumpkin(), PUMPKIN_RESPAWN_MS);
    if (!p?.animal || !this.players.has(p)) return;
    const xp = pumpkinXP(e.subspecies, p.animal.tier, Lr.length);
    p.goals = (p.goals ?? 0) + 1;
    const total = recordsRef?.addGoal(p) ?? p.goals;
    p.xp += xp;
    this.sendXP(p);
    this.checkProgress(p);
    // The client turns a hole's display off 3 s after its last update, so tick() keeps resending
    // it: the GOAL ring first, then the scorer's stats.
    const now = Date.now();
    this.goalShows.set(hole.id, {
      hole, goalUntil: now + 2500, statsUntil: now + 6000,
      goal: { state: GOAL_STATE.GOAL, variant: e.subspecies },
      stats: { state: GOAL_STATE.STATS, name: p.name || "Unnamed", goals: total, xp },
    });
    this.serverMessage(p, `GOAL! ${PUMPKINS[e.subspecies].name} pumpkin +${xp.toLocaleString("en-US")} XP · ${total} goals all time`);
  }

  // Moves shot pumpkins; returns their position records for this tick.
  movePumpkins(dt) {
    const records = [];
    for (const e of this.moving) {
      if (!this.entities.has(e.id)) {
        this.moving.delete(e);
        continue;
      }
      const x0 = e.x, y0 = e.y;
      e.x = Math.min(MAP.x, Math.max(0, e.x + e.vx * dt));
      e.y = Math.min(MAP.y, Math.max(0, e.y + e.vy * dt));
      if (e.x === 0 || e.x === MAP.x) e.vx = -e.vx;
      if (e.y === 0 || e.y === MAP.y) e.vy = -e.vy;
      e.vx *= 0.94;
      e.vy *= 0.94;
      for (const o of this.players) {
        const t = o.animal;
        if (!t || o === e.shooter || Math.hypot(t.x - e.x, t.y - e.y) > t.size / 2 + e.size / 2) continue;
        const d = Math.hypot(e.vx, e.vy) || 1;
        if (d < 600) continue; // slow ones are just pushed along (eat → kickPumpkin)
        t.x = Math.min(MAP.x, Math.max(0, t.x + (e.vx / d) * 120));
        t.y = Math.min(MAP.y, Math.max(0, t.y + (e.vy / d) * 120));
        o.target = { x: t.x, y: t.y };
        e.vx *= -0.4;
        e.vy *= -0.4;
      }
      // A pumpkin moves farther per tick than a hole is wide, so check this tick's whole path.
      const hole = this.holes.find((h) => segmentDistance(h.x, h.y, x0, y0, e.x, e.y) <= h.size / 2);
      if (hole && e.shooter) {
        this.moving.delete(e);
        this.scoreGoal(e, hole);
        continue;
      }
      records.push(record((w) => writePumpkinSync(w, e)));
      if (Math.hypot(e.vx, e.vy) < 20) {
        if (DEBUG && e.shooter) console.log(`pumpkin stopped at ${Math.round(e.x)},${Math.round(e.y)}`);
        this.moving.delete(e);
        e.vx = e.vy = 0;
      }
    }
    return records;
  }

  // Shot pumpkins are extras: one that hasn't scored a minute after it was last touched goes away.
  clearOldShots(now) {
    for (const e of this.entities.values())
      if (e.type === "pumpkin" && e.shot && !this.moving.has(e) && now - (e.kicked ?? 0) > 60_000) this.removeEntity(e.id);
  }

  tick() {
    const dt = TICK_MS / 1000;
    const minimap = ++this.ticks % 40 === 1 ? this.minimapRecord() : null; // every 2 s
    const leaderboard = this.ticks % 20 === 1 ? this.leaderboardRecord() : null; // every 1 s
    const pumpkins = this.movePumpkins(dt);
    if (this.ticks % 5 === 0) // goal displays, 4 times a second
      for (const [id, show] of this.goalShows) {
        const now = Date.now();
        if (now > show.statsUntil || !this.entities.has(id)) {
          this.goalShows.delete(id);
          continue;
        }
        pumpkins.push(record((w) => writeHoleGoal(w, show.hole, now < show.goalUntil ? show.goal : show.stats)));
      }
    const now = Date.now();
    if (this.ticks % 5 === 0) // keep loaded slingshots showing for players who just joined
      for (const sling of this.slingshots) if (sling.loaded) pumpkins.push(record((w) => writeSlingshot(w, sling, { loaded: sling.loaded.animal })));
    this.combatStep(now);
    const records = [];
    for (const p of this.players) {
      const a = p.animal;
      if (!a) continue;
      if (p.flight) {
        if (this.fly(p, now)) continue; // flung into the sky
      } else {
        if (!a.fx?.stunned && !a.fx?.web && !a.fx?.frozen) this.move(p, dt);
        this.slingshotStep(p, now, pumpkins);
        if (!p.sling && this.portalStep(p, now)) continue;
      }
      this.vitalsStep(p, dt, now);
      if (!p.animal) continue; // ran dry
      this.cakeStep(p, now);
      // ease toward the size XP calls for, so growing and shrinking animate
      const target = this.targetSize(p) * (1 + CAKE_GROWTH * (p.cakeLayer ?? 0));
      a.size += Math.abs(target - a.size) < 0.05 ? target - a.size : (target - a.size) * 0.15;
      records.push(record((w) => writeAnimalSync(w, a)));
    }
    for (const p of this.players) {
      if (p.ws.readyState !== 1) continue;
      const groups = [["position", [...records, ...pumpkins]]];
      if (minimap) groups.push(["minimap", [minimap]]);
      if (leaderboard) groups.push(["leaderboard", [leaderboard]]);
      // The client's camera starts at Infinity and only snaps into place on a camera update.
      const focus = p.animal ?? p.camera;
      if (focus)
        groups.push(["camera", [encode("camera", {
          x: precision(focus.x, MAP.x, 16), y: precision(focus.y, MAP.y, 16), zoom: precision(this.zoomOf(p), 15, 8),
        })]]);
      // Always send something so the client's silence watchdog stays happy.
      p.ws.send(records.length || pumpkins.length || focus || minimap || leaderboard ? updateMessage(groups) : new Uint8Array([St.pong.encoder]));
    }
    if (this.ticks % 20 === 0) for (const cake of this.cakes) this.cakeSecond(cake, now);
    if (this.ticks % 100 === 0) this.clearOldShots(now);
  }

  // Camera zoom (lower sees more): /zoom's setting, wider on the cake's layers and in flight.
  zoomOf(p) {
    return (p.zoom ?? 1) * (1 - CAKE_VIEW * (p.cakeLayer ?? 0)) * (p.flight ? 0.8 : 1);
  }

  // ---------- giant cake ----------
  // Three layers (the client draws them at 100%, 68% and 38% of its size). Each layer you stand on
  // makes you bigger and widens your view. The animal that has held the top layer longest is king
  // of the hill and earns XP every few seconds. The cake keeps putting out party food around it,
  // better food the higher anyone is standing.

  cakeStep(p, now) {
    const a = p.animal;
    let layer = 0, on = null;
    if (!a.flying)
      for (const cake of this.cakes) {
        const d = Math.hypot(a.x - cake.x, a.y - cake.y), r = cake.size / 2;
        if (d >= r) continue;
        on = cake;
        layer = CAKE_LAYERS.filter((share) => d < r * share).length;
        break;
      }
    if (layer === 3 && p.cakeLayer !== 3) p.topSince = now;
    if (layer !== 3) p.topSince = null;
    p.cakeLayer = layer;
    p.cake = on;
  }

  cakeSecond(cake, now) {
    const on = [...this.players].filter((p) => p.animal && p.cake === cake);
    // king of the hill
    const top = on.filter((p) => p.cakeLayer === 3).sort((a, b) => a.topSince - b.topSince);
    const king = top[0];
    if (cake.king !== king) {
      cake.king = king;
      if (king) {
        king.kingXPAt = now + CAKE_KING_MS;
        this.serverMessage(king, "You're king of the cake! Hold the top layer to earn XP.");
      }
    }
    if (king && now >= king.kingXPAt) {
      king.kingXPAt = now + CAKE_KING_MS;
      king.xp += this.foodXP(king.animal) * 3;
      this.sendXP(king);
      this.checkProgress(king);
    }
    // party food
    const best = Math.max(0, ...on.map((p) => p.cakeLayer));
    if (now < (cake.foodAt ?? 0)) return;
    cake.foodAt = now + (best ? 1500 : 4000);
    const out = [...this.entities.values()].filter((e) => e.fromCake === cake.id).length;
    if (out >= CAKE_FOOD_MAX) return;
    const menu = CAKE_FOODS[best];
    const name = menu[Math.floor(this.rand() * menu.length)];
    const angle = this.rand() * Math.PI * 2, d = cake.size / 2 + 30 + this.rand() * 160;
    const x = cake.x + Math.cos(angle) * d, y = cake.y + Math.sin(angle) * d;
    this.addEntity({
      type: "food", species: D[name], biome: cake.biome, x, y, size: name === "gift" || name === "cake_slice" ? 34 : 20,
      angle: this.rand() * Math.PI * 2, fromCake: cake.id, ...(STYLED_FOODS.has(name) ? { style: 1 + Math.floor(this.rand() * 7) } : {}),
    });
  }

  // ---------- slingshots ----------
  // Walk onto the pad to load it, then move back to pull the band (up to 130). Point forward again
  // (or boost) to let go: you fly the way the slingshot faces, further the harder you pulled.
  // Walking off forward without pulling unloads it.

  slingshotStep(p, now, syncs) {
    const a = p.animal;
    const sling = p.sling;
    if (!sling) {
      if (now < (p.slingReadyAt ?? 0)) return;
      for (const s of this.slingshots)
        if (!s.loaded && Math.hypot(a.x - s.x, a.y - s.y) < 45 + a.size * 0.15) {
          s.loaded = p;
          p.sling = s;
          syncs.push(record((w) => writeSlingshot(w, s, { loaded: a })));
          return;
        }
      return;
    }
    const cos = Math.cos(sling.angle), sin = Math.sin(sling.angle);
    const rx = a.x - sling.x, ry = a.y - sling.y;
    let along = rx * cos + ry * sin, across = -rx * sin + ry * cos; // along > 0 is in front of the pad
    const pull = Math.max(0, -along);
    const aim = (p.target.x - sling.x) * cos + (p.target.y - sling.y) * sin;
    if (pull >= SLING_MIN_PULL && (aim > along + 40 || a.boostUntil > now)) return this.launch(p, pull, now, syncs);
    if (along > 30 || Math.abs(across) > 80) {
      this.unloadSlingshot(p, syncs);
      p.slingReadyAt = now + 800;
      return;
    }
    // the band holds the animal on the pad's track
    along = Math.min(30, Math.max(-SLING_MAX_PULL, along));
    across = Math.min(40, Math.max(-40, across));
    a.x = sling.x + along * cos - across * sin;
    a.y = sling.y + along * sin + across * cos;
  }

  launch(p, pull, now, syncs) {
    const a = p.animal, sling = p.sling;
    const power = Math.min(1, pull / SLING_MAX_PULL);
    const distance = 700 + 2600 * power;
    const ms = 700 + 1100 * power;
    p.flight = {
      x0: a.x, y0: a.y, t0: now, ms, toSky: power >= 0.85 && this.layer === "surface", // a near-full pull reaches the sky
      x1: Math.min(MAP.x - 50, Math.max(50, a.x + Math.cos(sling.angle) * distance)),
      y1: Math.min(MAP.y - 50, Math.max(50, a.y + Math.sin(sling.angle) * distance)),
    };
    a.flying = true;
    a.angle = sling.angle;
    a.vx = a.vy = 0;
    sling.loaded = null;
    p.sling = null;
    p.slingReadyAt = now + ms + 1500;
    syncs.push(record((w) => writeSlingshot(w, sling, { fired: true })));
  }

  fly(p, now) {
    const a = p.animal, f = p.flight;
    const t = Math.min(1, (now - f.t0) / f.ms);
    const k = 1 - (1 - t) ** 2; // fast off the band, easing into the landing
    a.x = f.x0 + (f.x1 - f.x0) * k;
    a.y = f.y0 + (f.y1 - f.y0) * k;
    a.biomeHere = Math.hypot(a.x - this.volcano.x, a.y - this.volcano.y) < this.volcano.r ? E.volcano : E[this.biomeAt(a.x, a.y)];
    if (t < 1) return false;
    const toSky = f.toSky;
    p.flight = null;
    a.flying = false;
    p.target = { x: a.x, y: a.y };
    if (!toSky) return false;
    this.transfer(p, "sky", { at: { x: a.x, y: a.y } });
    return true;
  }

  // Lets go of a loaded slingshot without firing (the animal left, died or changed).
  unloadSlingshot(p, syncs) {
    const sling = p.sling;
    if (!sling) return;
    sling.loaded = null;
    p.sling = null;
    const rec = record((w) => writeSlingshot(w, sling, { fired: false }));
    if (syncs) syncs.push(rec);
    else this.broadcast(updateMessage([["position", [rec]]]));
  }

  close() {
    clearInterval(this.timer);
    this.timer = null;
    for (const l of this.layers.values()) l.close();
  }
}

// ---------- server ----------

export function createGameServer({ accounts, records = null, parties, map = null }) {
  accountsRef = accounts;
  recordsRef = records;
  recordedMap = map;
  const lobbies = new Map(REGIONS.map((r) => [r.id, new Lobby(r)]));
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has("mope.session") ? "mope.session" : false),
  });
  const allLobbies = () => [...lobbies.values(), ...parties.lobbies()].flatMap((l) => [l, ...l.layers.values()]);
  const allPlayers = () => allLobbies().flatMap((l) => [...l.players]);

  function lobbyFor(regionId) {
    return lobbies.get(regionId);
  }

  // Moves a connected player into another lobby (joining a party by invite code).
  function moveTo(p, to) {
    const from = p.lobby;
    from.despawn(p, false);
    from.players.delete(p);
    const gone = [...from.entities.keys(), ...[...from.players].filter((o) => o.animal).map((o) => o.animal.id)];
    for (let i = 0; i < gone.length; i += 400)
      p.ws.send(updateMessage([["destroyEntity", gone.slice(i, i + 400).map((id) => encode("destroyEntity", { hasKiller: false, id }))]]));
    if (from.party) parties.leave(from.base ?? from);
    p.lobby = to;
    to.players.add(p);
    p.ws.send(encode("init", { inviteID: to.party ?? "", version: PROTOCOL_VERSION }));
    to.sendWorld(p);
  }

  function onMessage(p, data) {
    const lobby = p.lobby;
    const bytes = new Uint8Array(data);
    const name = clientMessages[bytes[0]];
    if (DEBUG && name !== "pointerPosition" && name !== "ping") console.log("<-", lobby.region.id, name ?? bytes[0]);
    let msg = {};
    try {
      const reader = new Reader(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), false, { start: 1 });
      if (c_[name]) msg = c_[name].decode(reader);
    } catch (e) {
      return DEBUG && console.warn(`bad ${name} message:`, e.message);
    }
    const ctx = { lobby, player: p, allPlayers, lobbies, encode, game, MAP, ROLES: nr, accounts, records };
    switch (name) {
      case "ping":
        return p.ws.send(new Uint8Array([St.pong.encoder]));
      case "startGameSession": {
        p.name = (msg.name || p.account?.displayName || "").slice(0, 32);
        p.xp = 0;
        p.kills = 0;
        p.shownResource = null;
        p.autoFloor = 0;
        p.fixedSize = null;
        p.spawnedAt = Date.now();
        // Invite links carry the party code; join that party if it isn't the one we're in.
        let target = lobby;
        if (lobby.party && msg.inviteID && msg.inviteID !== lobby.party) {
          const party = parties.get(msg.inviteID);
          if (party) moveTo(p, (target = party));
          else lobby.serverMessage(p, "That party has ended, or its link has expired. Started a new one.");
        }
        target.spawn(p, "mouse");
        if (p.animal) p.animal.immuneUntil = Date.now() + SPAWN_IMMUNITY_MS;
        if (target.party)
          target.serverMessage(p, `Party ${target.party} · invite: ${p.origin}/?server=${p.serverId}&mode=PARTY&inviteID=${target.party}`);
        return;
      }
      case "stopGameSession":
        return lobby.despawn(p);
      case "startSpectate":
        p.camera = { x: MAP.x / 2, y: MAP.y / 2 };
        return;
      case "stopSpectate":
        p.camera = null;
        return;
      case "pointerPosition":
        p.target = { x: (msg.x / 65535) * MAP.x, y: (msg.y / 65535) * MAP.y };
        return;
      case "startBoost":
        return lobby.boost(p);
      case "movementLocked":
        p.movementLocked = !!msg.value;
        return;
      // While a menu is open, Up/Down step on from the tier it shows.
      case "upgrade":
        return p.animal && lobby.showTier(p, (p.menu.length ? p.menuTier : p.animal.tier) + 1);
      case "downgrade":
        return p.animal && lobby.showTier(p, (p.menu.length ? p.menuTier : p.animal.tier) - 1);
      case "upgradeSlot": {
        const slug = p.menu[msg.slot];
        p.menu = [];
        p.skinOverride = msg.skinOverride;
        if (p.animal && slug) lobby.switchAnimal(p, slug, 0, p.menuSandbox);
        return;
      }
      case "chatMessage": {
        const chat = (msg.chat ?? "").slice(0, 200);
        if (chat.startsWith("/")) return runCommand(ctx, chat);
        if (p.animal)
          lobby.broadcast(updateMessage([["chatMessage", [encode("chatMessage", { id: p.animal.id, chat, translate: false })]]]));
        return;
      }
      // Built-in staff tools of the client (admin panel, observe, teleport, kick/ban, move/destroy).
      case "adminUserList":
      case "adminTeleport":
      case "targetPlayer":
      case "modDisconnect":
      case "modBan":
      case "move":
      case "destroy":
        return runCommand(ctx, { tool: name, ...msg });
    }
  }

  function accept(req, socket, head) {
    const url = new URL(req.url, "http://x");
    const [, , regionId, partyCode] = url.pathname.split("/"); // /play/<region>[/<party>]
    const region = REGIONS.find((r) => r.id === regionId);
    const lobby = !region ? null : partyCode ? parties.join(region, partyCode) : lobbyFor(regionId);
    if (!lobby) return socket.destroy();
    const account = accounts.fromRequest(req);
    if (account && accounts.isBanned(account)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      const p = {
        ws, account, lobby, name: "", animal: null, target: { x: 0, y: 0 }, menu: [], menuTier: 1, xp: 0,
        role: account?.role ?? nr.USER,
        // the client offers ["mope.session", <session id>, <previous session id>]
        sessionId: String(req.headers["sec-websocket-protocol"] ?? "").split(",")[1]?.trim() ?? "",
        ip: req.socket.remoteAddress ?? "",
        origin: `${req.headers["x-forwarded-proto"] ?? "http"}://${req.headers.host}`,
        serverId: partyCode ? `local-${regionId}-party` : `local-${regionId}`,
      };
      lobby.players.add(p);
      ws.send(encode("init", { inviteID: lobby.party ?? "", version: PROTOCOL_VERSION }));
      lobby.sendWorld(p);
      ws.on("message", (data) => onMessage(p, data));
      ws.on("close", () => {
        p.lobby.despawn(p, false);
        p.lobby.players.delete(p);
        if (p.lobby.party) parties.leave(p.lobby.base ?? p.lobby);
      });
    });
  }

  // The client POSTs <server url>/auth/login|logout with its session id when the player signs
  // in or out while connected; re-read the account from the request's cookie.
  function relink(sessionId, account) {
    for (const p of allPlayers())
      if (p.sessionId && p.sessionId === sessionId) {
        p.account = account;
        p.role = account?.role ?? nr.USER;
      }
  }

  return {
    accept,
    relink,
    stats: () => Object.fromEntries([...lobbies].map(([id, l]) => [id, l.playerCount + [...l.layers.values()].reduce((n, x) => n + x.playerCount, 0)])),
    lobbies,
    // Switches every lobby to a recorded map (or back to generated worlds with null).
    setMap(map) {
      recordedMap = map;
      for (const l of [...lobbies.values(), ...parties.lobbies()]) l.rebuildWorld();
    },
  };
}
