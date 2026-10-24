// AI animals, so no world is ever empty. Each has a skill level (easy, normal, hard). Bots are players without a connection: they spawn,
// eat, drink, flee animals that can eat them, hunt animals they can eat, use their abilities,
// pick upgrades and respawn after dying. They show on the in-game leaderboard but never on the
// worldwide boards or the server list's player counts.
//
// BOTS (default 8) sets how many each region's FFA world gets; Teams and Battle Royale worlds get
// a few too. /bots <n> changes it for the world you're in.
import { M, T, canEatAnimal, getLayerOfBiome } from "./game-server.js";
import { startAbility, effectOf } from "./abilities.js";

const BOT_NAMES = [
  "Pip", "Mochi", "Biscuit", "Nugget", "Pebble", "Ziggy", "Clover", "Maple", "Sprout", "Tofu", "Waffle", "Echo",
  "Juniper", "Comet", "Pickles", "Bramble", "Sunny", "Rusty", "Hazel", "Noodle", "Ripple", "Dusty", "Kiwi", "Fable",
  "Sable", "Truffle", "Basil", "Orbit", "Puddle", "Quill", "Sorrel", "Thistle", "Wren", "Yarrow", "Bean", "Cosmo",
];
const STARTERS = ["mouse", "chipmunk", "kangaroo_rat", "lemming", "shrimp"];
// Skill levels: how often a bot decides, how far it sees, how keen it is to boost, whether it
// picks abilities for the moment (escape vs attack) and leads moving prey.
const SKILLS = {
  easy: { think: 650, sight: 0.75, boost: 0.1, smart: false, lead: false },
  normal: { think: 400, sight: 1, boost: 0.25, smart: true, lead: false },
  hard: { think: 250, sight: 1.25, boost: 0.5, smart: true, lead: true },
};
const ESCAPES = new Set(["shell", "spikes", "burrow", "fly", "jump", "dash", "stun", "freeze", "web", "gust", "push", "dive"]);
const ATTACKS = new Set(["strike", "claw", "grab", "venom", "fire", "shock", "quake", "poison", "pull", "freeze", "web", "stun", "dash"]);
const RESPAWN_MS = 6000;

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[Math.floor(Math.random() * list.length)];

export function addBot(lobby, { name, slug, boss = false } = {}) {
  const used = new Set([...lobby.players].map((p) => p.name));
  const p = {
    bot: true, boss, ws: { readyState: 1, send() {} }, account: null, role: 0, lobby,
    name: name ?? (BOT_NAMES.find((n) => !used.has(n)) ?? `Bot ${lobby.players.size + 1}`),
    animal: null, target: { x: 0, y: 0 }, menu: [], menuTier: 1, xp: 0, kills: 0, nextThink: 0,
    respawnAt: 0, startSlug: slug,
    skill: boss ? "hard" : pick(["easy", "normal", "normal", "hard"]),
  };
  lobby.players.add(p);
  if (lobby.mode === "TEAMS") lobby.pickTeamFor?.(p);
  spawnBot(lobby, p, Date.now());
  return p;
}

export function removeBot(lobby, p) {
  lobby.despawn(p, false);
  lobby.players.delete(p);
}

function spawnBot(lobby, p, now) {
  p.xp = 0;
  p.kills = 0;
  p.menu = [];
  const slug = p.startSlug ?? pick(STARTERS);
  lobby.spawn(p, slug, 0, { redirect: false });
  const a = p.animal;
  if (!a) return;
  // somewhere in its home biome rather than everyone at the middle
  const home = lobby.homeArea(slug);
  if (home) Object.assign(a, { x: rand(home.x0, home.x1), y: rand(home.y0, home.y1) });
  a.immuneUntil = now + 3000;
  p.target = { x: a.x, y: a.y };
  p.wanderUntil = 0;
}

// Every tick, before movement: respawns and decisions for this lobby's bots.
export function botsStep(lobby, now) {
  for (const p of lobby.players) {
    if (!p.bot) continue;
    if (!p.animal) {
      if (p.boss) {
        lobby.players.delete(p);
        continue;
      }
      if (!p.respawnAt) p.respawnAt = now + RESPAWN_MS;
      if (now >= p.respawnAt) (p.respawnAt = 0), spawnBot(lobby, p, now);
      continue;
    }
    if (now >= p.nextThink) {
      p.nextThink = now + (SKILLS[p.skill] ?? SKILLS.normal).think + Math.random() * 200;
      think(lobby, p, now);
    }
  }
}

function think(lobby, p, now) {
  const a = p.animal;
  if (p.boss) p.menu = []; // bosses stay the monster they came as
  // upgrades: pick a card after a moment, staying in this world
  if (p.menu.length) {
    p.pickAt ??= now + rand(1200, 3500);
    if (now >= p.pickAt) {
      p.pickAt = null;
      const ok = p.menu.map((slug, i) => [slug, i]).filter(([slug]) => getLayerOfBiome(M[slug].biome) === lobby.layer && M[slug].biome !== "volcano");
      const [slug, i] = ok.length ? pick(ok) : [p.menu[0], 0];
      const sub = p.menuSubspecies?.[i] ?? 0;
      const sandbox = p.menuSandbox;
      p.menu = [];
      lobby.switchAnimal(p, slug, sub, sandbox);
      return;
    }
  }
  const skill = SKILLS[p.skill] ?? SKILLS.normal;
  const kind = (a.ability ??= effectOf(lobby.abilityName(a)));
  const use = (when) => when && !a.abilityActive && now >= (a.abilityReadyAt ?? 0) && startAbility(lobby, p, now);
  let threat = null, threatD = Infinity, prey = null, preyD = Infinity;
  for (const q of lobby.players) {
    const b = q.animal;
    if (!b || q === p) continue;
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d < (420 + b.size) * skill.sight && d < threatD && canEatAnimal(b, a) && lobby.canHurt(p, q, now)) (threat = b), (threatD = d);
    if (d < 520 * skill.sight && d < preyD && (canEatAnimal(a, b) || (p.boss && b.tier <= a.tier)) && lobby.canHurt(q, p, now)) (prey = b), (preyD = d);
  }
  if (threat && !p.boss) {
    const dx = a.x - threat.x, dy = a.y - threat.y, d = Math.hypot(dx, dy) || 1;
    p.target = lobby.clampToMap({ x: a.x + (dx / d) * 500, y: a.y + (dy / d) * 500 });
    if (threatD < threat.size + 160 && Math.random() < skill.boost * 2) lobby.boost(p);
    if (threatD < threat.size + 100) use(skill.smart ? ESCAPES.has(kind) : Math.random() < 0.3);
    return;
  }
  if ((a.health ?? 100) < 55 && kind === "heal") use(true);
  if ((a.resource ?? 100) < 35) {
    const drink = lobby.nearestDrink(a);
    if (drink) return void (p.target = drink);
  }
  // join a pack: prey another bot nearby is already chasing
  if (!prey) {
    for (const [id, until] of (lobby.packTargets ??= new Map())) {
      if (now > until) { lobby.packTargets.delete(id); continue; }
      const q = [...lobby.players].find((o) => o.animal?.id === id);
      const b = q?.animal;
      if (b && Math.hypot(b.x - a.x, b.y - a.y) < 900 && canEatAnimal(a, b) && lobby.canHurt(q, p, now)) { prey = b; preyD = Math.hypot(b.x - a.x, b.y - a.y); break; }
    }
  }
  if (prey && (a.health ?? 100) > 35) {
    (lobby.packTargets ??= new Map()).set(prey.id, now + 3000);
    const lead = skill.lead ? 0.35 : 0; // hard bots aim where the prey is going
    p.target = lobby.clampToMap({ x: prey.x + (prey.vx ?? 0) * lead, y: prey.y + (prey.vy ?? 0) * lead });
    const reach = a.size + prey.size + 60;
    if (preyD < reach * 2 && Math.random() < skill.boost) lobby.boost(p);
    if (preyD < reach) use(skill.smart ? ATTACKS.has(kind) : Math.random() < 0.3);
    return;
  }
  const food = lobby.nearestFood(a, 700 * skill.sight);
  if (food) return void (p.target = { x: food.x, y: food.y });
  if (kind === "forage") use(true);
  if (now >= (p.wanderUntil ?? 0)) {
    p.wanderUntil = now + rand(2500, 5000);
    p.target = lobby.clampToMap({ x: a.x + rand(-600, 600), y: a.y + rand(-600, 600) });
  }
}
