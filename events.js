// World events in each region's FFA world, one every 6-10 minutes (the first after 3), announced
// to everyone there:
//   - Double XP: food is worth twice as much for 3 minutes.
//   - Meteor shower: meteors land over half a minute. Each one hurts animals near it, leaves a
//     lava crater for a few seconds and scatters treats.
//   - Pumpkin rush: a dozen rare pumpkins roll out (gold and up).
//   - Boss: a huge, tough monster prowls for 5 minutes. It takes a fifth of normal damage, and
//     whoever eats it gets five times the XP and 100 coins.
// Staff can start one with /event <double|meteors|pumpkins|boss>.
import { D, pm, MAP, DEATH } from "./game-server.js";
import { addBot, removeBot } from "./bots.js";
import { PUMPKINS } from "./pumpkins.js";

const FIRST_MS = 3 * 60_000;
const GAP_MS = [6 * 60_000, 10 * 60_000];
const DOUBLE_XP_MS = 3 * 60_000;
const BOSS_MS = 5 * 60_000;
const BOSSES = ["dino_monster", "sea_monster", "ice_monster", "giant_scorpion"];
const TREATS = ["golden_egg", "watermelon", "mushroom_bush", "gift", "cupcake", "melon"];
export const EVENT_NAMES = ["double", "meteors", "pumpkins", "boss"];

const tell = (lobby, message) => { for (const p of lobby.allHere()) lobby.serverMessage(p, message); };
const pick = (list) => list[Math.floor(Math.random() * list.length)];

export function eventsStep(lobby, now) {
  if (lobby.mode !== "FFA" || lobby.layer !== "surface" || lobby.party) return;
  lobby.nextEventAt ??= now + FIRST_MS;
  if (lobby.boss && (!lobby.boss.animal || now > lobby.bossUntil)) endBoss(lobby);
  if (now < lobby.nextEventAt) return;
  lobby.nextEventAt = now + GAP_MS[0] + Math.random() * (GAP_MS[1] - GAP_MS[0]);
  if ([...lobby.players].some((p) => !p.bot)) startEvent(lobby, pick(EVENT_NAMES), now);
}

export function startEvent(lobby, name, now = Date.now()) {
  switch (name) {
    case "double":
      lobby.xpBoostUntil = now + DOUBLE_XP_MS;
      return tell(lobby, "⭐ Double XP for 3 minutes!");
    case "meteors":
      tell(lobby, "☄️ Meteor shower! Watch the sky…");
      for (let i = 0; i < 10; i++) setTimeout(() => lobby.timer && meteor(lobby), 2000 + i * 2500 + Math.random() * 1500);
      return;
    case "pumpkins": {
      const rare = PUMPKINS.map((v, i) => [v, i]).filter(([v]) => v.weight <= 120).map(([, i]) => i);
      for (let i = 0; i < 12; i++) lobby.spawnPumpkin(true, pick(rare));
      return tell(lobby, "🎃 Pumpkin rush! Rare pumpkins are rolling around. Score them into holes!");
    }
    case "boss": {
      if (lobby.boss) return;
      const slug = pick(BOSSES);
      const boss = addBot(lobby, { name: `👑 ${lobby.animalName(slug)}`, slug, boss: true });
      if (!boss.animal) return;
      boss.xp = 50_000_000_000;
      boss.animal.shieldMultiplier = 0.2;
      lobby.boss = boss;
      lobby.bossUntil = now + BOSS_MS;
      return tell(lobby, `👑 A boss ${lobby.animalName(slug)} appeared! It's tough. Team up to eat it for 5× XP and 100 coins.`);
    }
    default:
      throw new Error(`events: ${EVENT_NAMES.join(", ")}`);
  }
}

function endBoss(lobby) {
  const boss = lobby.boss;
  lobby.boss = null;
  if (boss.animal) {
    removeBot(lobby, boss);
    tell(lobby, "The boss wandered off…");
  }
}

function meteor(lobby) {
  const b = lobby.landArea();
  const x = b.x0 + Math.random() * (b.x1 - b.x0), y = b.y0 + Math.random() * (b.y1 - b.y0);
  const now = Date.now();
  for (const p of lobby.players) {
    const a = p.animal;
    if (a && Math.hypot(a.x - x, a.y - y) < 160 + a.size / 2) lobby.hurt(p, 25, null, now, DEATH.ENVIRONMENT);
  }
  const crater = lobby.addEntity({ type: "puddle", species: pm.LAVA, biome: 0, x, y, size: 170, angle: 0 });
  setTimeout(() => lobby.timer && lobby.entities.get(crater.id) === crater && lobby.removeEntity(crater.id), 6000);
  for (let i = 0; i < 4; i++) {
    const t = Math.random() * Math.PI * 2, r = 120 + Math.random() * 80;
    const name = pick(TREATS);
    const e = lobby.addEntity({
      type: "food", species: D[name], biome: 0, x: Math.min(MAP.x, Math.max(0, x + Math.cos(t) * r)), y: Math.min(MAP.y, Math.max(0, y + Math.sin(t) * r)),
      size: 30, angle: t, fromKill: true, ...(["gift", "cupcake"].includes(name) ? { style: 1 + Math.floor(Math.random() * 7) } : {}),
    });
    setTimeout(() => lobby.timer && lobby.entities.get(e.id) === e && lobby.removeEntity(e.id), 60_000);
  }
}
