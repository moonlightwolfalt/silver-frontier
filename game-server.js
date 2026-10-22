// Usage: node game-server.js   (GAME_PORT=8443 by default)
// A minimal local sandbox server for the patched mope.io client's LOCALTEST region.
//
// It speaks the client's binary protocol by loading the client's own codec (bit reader/writer,
// message schemas, animal table) from mope-dump/ via client-runtime.js, and mirrors the
// hand-written entity readers (B/W.readInitProperties and .synchronize) for animals.
//
// What it does: spawn as a mouse in an empty world, move toward the pointer, and use the
// sandbox keys — Up (`upgrade`) / Down (`downgrade`) open the upgrade menu for the next/previous
// tier, and picking an animal (`upgradeSlot`) turns you into it. No food, other players' combat,
// XP, abilities or terrain.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { findClientChunk, loadClient } from "./client-runtime.js";

const PORT = Number(process.env.GAME_PORT || 8443);
const DEBUG = !!process.env.DEBUG;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TICK_MS = 50;
const SPEED = 300; // world units per second

const client = loadClient(findClientChunk(path.join(ROOT, "mope-dump/site/mope.io"), "var M = zr({"));
const S = client.get("S");
S.count = 0; // the client resets this counter before each message table; do the same
const St = client.get("St");
S.count = 0;
const s_ = client.get("s_");
const [Ot, c_, gt, T, M, Lr, E, gC, pg] = ["Ot", "c_", "gt", "T", "M", "Lr", "E", "gC", "pg"].map(client.get);
const Writer = client.get("lt");
const Reader = client.get("x");
const config = loadClient(findClientChunk(path.join(ROOT, "mope-dump/site/mope.io"), "protocolVersion:"));
const PROTOCOL_VERSION = config.get("c").protocolVersion;

const clientMessages = Object.fromEntries(Object.entries(s_).map(([name, s]) => [s.encoder, name]));
const MAP = { x: 0, y: 0 };
for (const b of Object.values(pg.biomes)) {
  MAP.x = Math.max(MAP.x, b.x + b.width / 2);
  MAP.y = Math.max(MAP.y, b.y + b.height / 2);
}
const SPAWN = {
  land: pg.biomes.land, arctic: pg.biomes.arctic, desert: pg.biomes.desert,
  ocean: pg.biomes.leftOcean, volcano: pg.biomes.land,
};
const MAX_ANIMAL_SIZE = M.king_dragon.maximumSize;
const precision = (v, max, bits) => Writer.toPrecision(v, max, bits);

// ---------- entity encoding (mirrors the client's readers) ----------

// createEntity record: type, then B + W readInitProperties.
function writeAnimalInit(w, a) {
  w.writeUint8(gC.animal);
  w.writeUint8(a.species); // createEntity peeks this byte, then B.readInitProperties reads it
  w.writeUint16(a.id);
  w.writeUint8(a.biome);
  w.writeUint16(Math.round(a.size)); // animals are dynamic and not dynamicallyCreated: no x/y/angle here
  w.writeUint8(a.subspecies);
  w.writeUint8(a.tier);
  w.writeUint16(0); // hole id
  w.writeString(a.name);
  w.writeString(""); // equipped skin id
  w.writeUint8(0); // flags: staff badge / name colour / account
}

// position record: 14-bit id, then B + W synchronize. Species-specific readers that read more
// after W.synchronize get zero padding, which they read as "flag off".
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
  w.writeBoolean(false); // spawn immunity
  w.writeBits(a.biome, 3);
  w.writeUint8(precision(a.angle, 2 * Math.PI, 8));
  w.writeUint8(100); // health
  w.writeUint16(precision(a.size, MAX_ANIMAL_SIZE, 16));
  if (M[T[a.species]].canClimbTree) w.writeBoolean(false); // in tree
  w.writeUint32(0); // padding for species-specific fields
}

// The client's writer only grows on byte-sized writes; bit writes assume the buffer is already
// big enough (the client pre-sizes from its schemas). So start with room and trim at the end.
const newWriter = () => new Writer(1024, true);
const written = (w) => w.buffer.slice(0, w.offset);

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

const record = (fn) => {
  const w = newWriter();
  fn(w);
  return written(w);
};
// Ot schemas used inside `update` carry no prefix byte; top-level ones do.
const encode = (name, data) => new Uint8Array(Ot[name].encode(data));

// ---------- world ----------

let nextId = 1;
const players = new Set();

function makeAnimal(slug, subspecies, name, id = nextId++, at) {
  const cfg = M[slug];
  const biomeName = cfg.animalResource?.type === 1 ? "volcano" : cfg.biome;
  const spawn = at ?? SPAWN[biomeName] ?? SPAWN.land;
  return {
    id, slug, name, subspecies,
    species: T[slug],
    tier: Lr.findIndex((t) => t.animals.includes(T[slug])) + 1,
    biome: E[biomeName] ?? E.land,
    size: (cfg.minimumSize + cfg.maximumSize) / 2,
    x: spawn.x, y: spawn.y, angle: 0,
  };
}

function broadcast(bytes) {
  for (const p of players) if (p.ws.readyState === 1) p.ws.send(bytes);
}

function spawn(p, slug, subspecies = 0) {
  const prev = p.animal;
  p.animal = makeAnimal(slug, subspecies, p.name, prev?.id, prev && { x: prev.x, y: prev.y });
  p.target = { x: p.animal.x, y: p.animal.y };
  broadcast(
    updateMessage([
      ["createEntity", [record((w) => writeAnimalInit(w, p.animal))]],
      ["position", [record((w) => writeAnimalSync(w, p.animal))]],
    ]),
  );
  // Others already in the world must exist on this client too.
  const others = [...players].filter((o) => o !== p && o.animal).map((o) => o.animal);
  if (!prev && others.length)
    p.ws.send(updateMessage([["createEntity", others.map((a) => record((w) => writeAnimalInit(w, a)))]]));
  p.ws.send(encode("startGameSession", { id: p.animal.id }));
}

// Sandbox upgrade menu: every animal of the chosen tier.
function showTier(p, tier) {
  p.menuTier = Math.min(Lr.length, Math.max(1, tier));
  p.menu = Lr[p.menuTier - 1].animals.map((species) => T[species]);
  p.ws.send(
    encode("upgradeMenu", {
      animals: p.menu.map((slug) => T[slug]),
      subspecies: p.menu.map(() => 0),
      equippedItemIds: p.menu.map(() => ""),
    }),
  );
}

function leave(p) {
  if (!p.animal) return;
  broadcast(updateMessage([["destroyEntity", [encode("destroyEntity", { hasKiller: false, id: p.animal.id })]]]));
  p.animal = null;
}

setInterval(() => {
  const dt = TICK_MS / 1000;
  const records = [];
  for (const p of players) {
    const a = p.animal;
    if (!a) continue;
    const dx = p.target.x - a.x, dy = p.target.y - a.y, dist = Math.hypot(dx, dy);
    if (dist > 5) {
      const step = Math.min(dist, SPEED * dt);
      a.x = Math.min(MAP.x, Math.max(0, a.x + (dx / dist) * step));
      a.y = Math.min(MAP.y, Math.max(0, a.y + (dy / dist) * step));
      a.angle = (Math.atan2(dy, dx) + Math.PI / 2 + 2 * Math.PI) % (2 * Math.PI);
    }
    records.push(record((w) => writeAnimalSync(w, a)));
  }
  for (const p of players) {
    if (p.ws.readyState !== 1) continue;
    const groups = [["position", records]];
    // The client's camera starts at Infinity and only snaps into place on a camera update.
    if (p.animal) groups.push(["camera", [encode("camera", { x: precision(p.animal.x, MAP.x, 16), y: precision(p.animal.y, MAP.y, 16), zoom: precision(1, 15, 8) })]]);
    // Always send something so the client's silence watchdog stays happy.
    p.ws.send(records.length ? updateMessage(groups) : new Uint8Array([St.pong.encoder]));
  }
}, TICK_MS);

// ---------- connections ----------

const wss = new WebSocketServer({
  port: PORT,
  handleProtocols: (protocols) => (protocols.has("mope.session") ? "mope.session" : false),
});

wss.on("connection", (ws) => {
  const p = { ws, name: "", animal: null, target: { x: 0, y: 0 }, menu: [], menuTier: 1 };
  players.add(p);
  if (DEBUG) console.log("connection");
  ws.send(encode("init", { inviteID: "", version: PROTOCOL_VERSION }));

  ws.on("message", (data) => {
    const bytes = new Uint8Array(data);
    const name = clientMessages[bytes[0]];
    const reader = new Reader(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), false, { start: 1 });
    if (DEBUG && name !== "pointerPosition") console.log("<-", name ?? bytes[0], bytes.byteLength + "B");
    let msg = {};
    try {
      if (c_[name]) msg = c_[name].decode(reader);
    } catch (e) {
      return console.warn(`bad ${name} message:`, e.message);
    }
    switch (name) {
      case "ping":
        return ws.send(new Uint8Array([St.pong.encoder]));
      case "startGameSession":
        p.name = (msg.name || "").slice(0, 32);
        return spawn(p, "mouse");
      case "stopGameSession":
        return leave(p);
      case "pointerPosition":
        p.target = { x: (msg.x / 65535) * MAP.x, y: (msg.y / 65535) * MAP.y };
        return;
      // While a menu is open, Up/Down step on from the tier it shows.
      case "upgrade":
        return p.animal && showTier(p, (p.menu.length ? p.menuTier : p.animal.tier) + 1);
      case "downgrade":
        return p.animal && showTier(p, (p.menu.length ? p.menuTier : p.animal.tier) - 1);
      case "upgradeSlot": {
        const slug = p.menu[msg.slot];
        p.menu = [];
        if (p.animal && slug) spawn(p, slug);
        return;
      }
    }
  });
  ws.on("close", () => {
    leave(p);
    players.delete(p);
  });
});

console.log(`mope local sandbox server on ws://localhost:${PORT} (protocol ${PROTOCOL_VERSION})`);
