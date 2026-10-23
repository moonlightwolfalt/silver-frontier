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
import { generateWorld } from "./world.js";
import { runCommand } from "./dev-commands.js";
import { PUMPKINS, pickPumpkin, pumpkinXP } from "./pumpkins.js";
import { MAX_XP } from "./limits.js";
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
const Reader = client.get("x");
const config = loadClient(findClientChunk(CLIENT_DIR, "protocolVersion:"));
export const PROTOCOL_VERSION = config.get("c").protocolVersion;
export const ROLES = nr;
export const game = { T, M, Lr, D, E };

let accountsRef = null; // set by createGameServer, used for equipped skins

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
  for (let i = 0; i < 7; i++) w.writeBoolean(false); // diving, healing, burning, frozen, bleeding, poisoned, stunned
  w.writeBoolean(false); // stuck in web
  w.writeBoolean(false); // constricted
  for (let i = 0; i < 7; i++) w.writeBoolean(false); // shivering, sweating, aloed, under bush, ability1, low resource, flying
  w.writeBoolean(true); // visible
  w.writeBoolean(!!a.godMode); // spawn immunity (shown while god mode is on)
  w.writeBits(a.biomeHere, 3);
  w.writeUint8(precision(a.angle, 2 * Math.PI, 8));
  w.writeUint8(100); // health
  w.writeUint16(precision(a.size, MAX_ANIMAL_SIZE, 16));
  if (M[T[a.species]].canClimbTree) w.writeBoolean(false); // in tree
  w.writeUint32(0); // padding for species-specific fields
}

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

// ---------- lobby ----------

function biomeAt(x, y) {
  const b = pg.biomes;
  const inside = (r) => Math.abs(x - r.x) <= r.width / 2 && Math.abs(y - r.y) <= r.height / 2;
  if (inside(b.arctic)) return "arctic";
  if (inside(b.desert)) return "desert";
  if (inside(b.leftOcean) || inside(b.rightOcean)) return "ocean";
  return "land";
}

export class Lobby {
  constructor(region, { mode = "FFA", party = null } = {}) {
    this.region = region;
    this.mode = mode;
    this.party = party; // party code for private party lobbies
    this.players = new Set();
    this.nextId = 1;
    this.entities = new Map(); // world objects and foods, by id
    this.moving = new Set(); // shot pumpkins still rolling
    const seed = [...(party ?? region.id)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
    const { entities, volcano } = generateWorld({ pg, E, D, cm, pm, sg, seed });
    this.volcano = volcano;
    for (const e of entities) this.addEntity(e, false);
    this.terrainZones = entities
      .filter((e) => ["island", "mud", "lake", "puddle", "river"].includes(e.type) && !(e.type === "puddle" && e.species === pm.LAVA))
      .sort((a, b) => (a.type === "island" ? -1 : 0) - (b.type === "island" ? -1 : 0)); // islands win over sea
    this.rand = (() => { let x = seed; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32); })();
    for (let i = 0; i < PUMPKIN_COUNT; i++) this.spawnPumpkin(false);
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
      type: "pumpkin", species: 0, subspecies: variant, biome: E[biomeAt(x, y)], x, y, size: 60, angle: this.rand() * Math.PI * 2,
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

  get playerCount() {
    return [...this.players].filter((p) => p.animal).length;
  }

  addEntity(e, announce = true) {
    e.id = this.nextId++;
    this.entities.set(e.id, e);
    if (announce) this.broadcast(updateMessage([["createEntity", [record((w) => writeInit(w, e))]]]));
    return e;
  }

  removeEntity(id) {
    if (!this.entities.delete(id)) return false;
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
    const spawn = at ?? (home === "volcano" ? this.volcano
      : home === "ocean" ? pg.biomes.leftOcean
      : pg.biomes[home] ?? pg.biomes.land);
    return {
      type: "animal",
      id: p.animal?.id ?? this.nextId++,
      slug, subspecies,
      species: T[slug],
      tier: Lr.findIndex((t) => t.animals.includes(T[slug])) + 1,
      biome: E[home] ?? E.land,
      biomeHere: E[home] ?? E.land,
      size: cfg.minimumSize,
      x: spawn.x, y: spawn.y, angle: 0,
      name: p.name,
      skin: p.skinOverride ?? accountsRef?.equippedSkin(p.account, slug) ?? "",
      staff: p.role >= nr.MODERATOR,
      hasAccount: !!p.account,
      godMode: p.animal?.godMode ?? false,
      speed: p.animal?.speed ?? 1,
    };
  }

  spawn(p, slug, subspecies = 0) {
    const prev = p.animal;
    p.animal = this.makeAnimal(p, slug, subspecies, prev && { x: prev.x, y: prev.y });
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

  despawn(p, stats = true) {
    if (!p.animal) return;
    const id = p.animal.id;
    p.animal = null;
    this.broadcast(updateMessage([["destroyEntity", [encode("destroyEntity", { hasKiller: false, id })]]]));
    if (stats)
      p.ws.send(encode("stopGameSession", {
        xp: Math.min(MAX_XP, p.xp), timeAlive: Math.round((Date.now() - (p.spawnedAt ?? Date.now())) / 1000), kills: 0, wins: 0,
        coinsEarned: 0, cause: 0, killerName: "", killerAnimal: 0, killerSubspecies: 0, killerSkin: "",
        via: 0, viaId: 0, castByName: "", castByAnimal: 0,
      }));
  }

  sendXP(p) {
    p.xp = Math.min(MAX_XP, Math.max(0, Math.round(p.xp)));
    p.ws.send(updateMessage([["xp", [encode("xp", { xp: p.xp, rank: 1 })]]]));
  }

  // serverMessage has no prefix byte in the client's schema: it travels inside an update.
  serverMessage(p, message) {
    p.ws.send(updateMessage([["serverMessage", [encode("serverMessage", { message, translate: false })]]]));
  }

  // Sandbox upgrade menu: every animal of the chosen tier.
  showTier(p, tier) {
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
  //  - tier 17: minimum at 10M, maximum at 10 trillion, on a log scale
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
    return biomeAt(x, y) === "ocean" ? "water" : "land";
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
    a.biomeHere = Math.hypot(a.x - this.volcano.x, a.y - this.volcano.y) < this.volcano.r ? E.volcano : E[biomeAt(a.x, a.y)];
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
  checkProgress(p) {
    if (!p.animal || p.menu.length) return;
    if (this.earnedTier(p) > p.animal.tier) this.showTier(p, p.animal.tier + 1);
  }

  // Food is worth about 1/30 of the gap to the next tier, so every tier takes a similar effort.
  foodXP(a) {
    const next = Lr[a.tier]?.requiredXP;
    if (next === undefined) return 25_000;
    return Math.max(25, Math.round((next - Lr[a.tier - 1].requiredXP) / 30));
  }

  eat(p) {
    const a = p.animal;
    for (const e of this.entities.values()) {
      if (e.type === "pumpkin" && !this.moving.has(e) && Math.hypot(e.x - a.x, e.y - a.y) <= a.size / 2 + e.size / 2) {
        this.collectPumpkin(p, e);
        continue;
      }
      if (e.type !== "food") continue;
      if (Math.hypot(e.x - a.x, e.y - a.y) > a.size / 2 + e.size / 2) continue;
      this.removeEntity(e.id);
      p.xp += this.foodXP(a);
      this.sendXP(p);
      this.checkProgress(p);
      const { id, ...food } = e;
      setTimeout(() => this.timer && this.addEntity(food), 8000);
    }
  }

  // Fires a pumpkin from the front of the player's animal in the direction it faces. It rolls,
  // slows down and stops, then can be collected like any other. Animals it hits are knocked back.
  shootPumpkin(p, variant, spread = 0) {
    const a = p.animal;
    const dir = a.angle + spread; // the client's angle is the facing direction
    const start = a.size / 2 + 40;
    const e = this.spawnPumpkin(true, variant, { x: a.x + Math.cos(dir) * start, y: a.y + Math.sin(dir) * start });
    Object.assign(e, { vx: Math.cos(dir) * 1400, vy: Math.sin(dir) * 1400, shooter: p, angle: dir, shot: true });
    this.moving.add(e);
    return e;
  }

  // Moves shot pumpkins; returns their position records for this tick.
  movePumpkins(dt) {
    const records = [];
    for (const e of this.moving) {
      if (!this.entities.has(e.id)) {
        this.moving.delete(e);
        continue;
      }
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
        t.x = Math.min(MAP.x, Math.max(0, t.x + (e.vx / d) * 120));
        t.y = Math.min(MAP.y, Math.max(0, t.y + (e.vy / d) * 120));
        o.target = { x: t.x, y: t.y };
        e.vx *= -0.4;
        e.vy *= -0.4;
      }
      records.push(record((w) => writePumpkinSync(w, e)));
      if (Math.hypot(e.vx, e.vy) < 20) {
        this.moving.delete(e);
        e.shooter = null; // now anyone, the shooter included, can collect it
      }
    }
    return records;
  }

  // Touching a pumpkin collects it: XP by variant and tier, then a new one spawns elsewhere.
  collectPumpkin(p, e) {
    const xp = pumpkinXP(e.subspecies, p.animal.tier, Lr.length);
    this.removeEntity(e.id);
    p.xp += xp;
    this.sendXP(p);
    this.serverMessage(p, `${PUMPKINS[e.subspecies].name} pumpkin! +${xp.toLocaleString("en-US")} XP`);
    if (!e.shot) setTimeout(() => this.timer && this.spawnPumpkin(), PUMPKIN_RESPAWN_MS); // shot ones are extras
    this.checkProgress(p);
  }

  tick() {
    const dt = TICK_MS / 1000;
    const minimap = ++this.ticks % 40 === 1 ? this.minimapRecord() : null; // every 2 s
    const pumpkins = this.movePumpkins(dt);
    const records = [];
    for (const p of this.players) {
      const a = p.animal;
      if (!a) continue;
      this.move(p, dt);
      // ease toward the size XP calls for, so growing and shrinking animate
      const target = this.targetSize(p);
      a.size += Math.abs(target - a.size) < 0.05 ? target - a.size : (target - a.size) * 0.15;
      records.push(record((w) => writeAnimalSync(w, a)));
    }
    for (const p of this.players) {
      if (p.ws.readyState !== 1) continue;
      const groups = [["position", [...records, ...pumpkins]]];
      if (minimap) groups.push(["minimap", [minimap]]);
      // The client's camera starts at Infinity and only snaps into place on a camera update.
      const focus = p.animal ?? p.camera;
      if (focus)
        groups.push(["camera", [encode("camera", {
          x: precision(focus.x, MAP.x, 16), y: precision(focus.y, MAP.y, 16), zoom: precision(p.zoom ?? 1, 15, 8),
        })]]);
      // Always send something so the client's silence watchdog stays happy.
      p.ws.send(records.length || pumpkins.length || focus || minimap ? updateMessage(groups) : new Uint8Array([St.pong.encoder]));
    }
  }

  close() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

// ---------- server ----------

export function createGameServer({ accounts, parties }) {
  accountsRef = accounts;
  const lobbies = new Map(REGIONS.map((r) => [r.id, new Lobby(r)]));
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has("mope.session") ? "mope.session" : false),
  });
  const allPlayers = () => [...lobbies.values(), ...parties.lobbies()].flatMap((l) => [...l.players]);

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
    if (from.party) parties.leave(from);
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
    const ctx = { lobby, player: p, allPlayers, lobbies, encode, game, MAP, ROLES: nr, accounts };
    switch (name) {
      case "ping":
        return p.ws.send(new Uint8Array([St.pong.encoder]));
      case "startGameSession": {
        p.name = (msg.name || p.account?.displayName || "").slice(0, 32);
        p.xp = 0;
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
        if (p.animal && slug) lobby.spawn(p, slug);
        lobby.checkProgress(p);
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
        if (p.lobby.party) parties.leave(p.lobby);
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
    stats: () => Object.fromEntries([...lobbies].map(([id, l]) => [id, l.playerCount])),
    lobbies,
  };
}
