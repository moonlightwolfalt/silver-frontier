// Abilities (W / right click), diving and tree climbing for every animal, the classic ones and
// the custom biomes' ones.
//
// mope.io has a different ability for nearly every animal, worked out on its own servers. Here
// each animal's ability name (from the client's own names, e.g. "Dig Hole!", "Throw Fire!") is
// sorted into one of a few effects the server runs, and the client's own animations play while
// it is active. Cooldowns show on the ability button.
import { encode, updateMessage, DEATH } from "./game-server.js";

// [pattern on the ability name, effect]. First match wins.
const RULES = [
  [/^$|No Ability/, "none"],
  [/^Spit Water|^Spit Dash/, "push"],
  [/Suffocate/, "grab"],
  [/Whirlpool|Wave|Sinkhole/, "pull"],
  [/Smash|Slap/, "quake"],
  [/Knock In Air/, "gust"],
  [/Babies/, "heal"],
  [/Dig Food|Search Food\/Fly|Throw Fruit/, "forage"],
  [/Dive Bomb|Sky Dive/, "dash"],
  [/^Dive!?$/, "dive"],
  [/Venom Bite|Throw Venom/, "venom"],
  [/Hide in Shell|Shell Up|Roll into Ball|Disguise|Phase|^Puff/, "shell"],
  [/Spikes|Inflate/, "spikes"],
  [/Dig Hole|Burrow|^Dig!|Dig Mud|Tunnel|Grown/, "burrow"],
  [/Fire|Flare|Supernova|Eruption|Breath/, "fire"],
  [/Freeze|Snowball/, "freeze"],
  [/Shock|Thunder|Lightning/, "shock"],
  [/Earthquake|Rumble|Slam|Stomp|Surge/, "quake"],
  [/Web/, "web"],
  [/Ink|Fart|Goo|Slime|Sting|^Spit$|Rattle/, "poison"],
  [/Gust/, "gust"],
  [/Black Hole|Devour/, "pull"],
  [/Glow|Twinkle|Pulse|Starsong|Moonlight|Sense|Probe/, "heal"],
  [/Roar|Howl|Squawk|Laugh|Whine|Echo|Dance|Hypnotize/, "stun"],
  [/Jump|Hop/, "jump"],
  [/Fly|Hover|Glide|Soar|Flutter|Mimic/, "fly"],
  [/Constrict|Coil|Latch|Grab|Talon|Catch|Pick Up|Pull from Hole|Target Prey|Spear/, "grab"],
  [/Claw|Maul|Swipe|Fury|Pincer|Pinch|Gnaw/, "claw"],
  [/Bite|Snap|Tail Whip|Kick|Headbutt|Attack|Peck|Shatter|Wiggle/, "strike"],
  [/Dash|Charge|Lunge|Pounce|Impact|Gallop|Swoop|Slide|Skip/, "dash"],
];
export const effectOf = (name) => RULES.find(([re]) => re.test(name ?? ""))?.[1] ?? "dash";

// Per effect: cooldown, how long a held one may last, and whether it is held (W down) or instant.
const EFFECTS = {
  none: { cd: 0 }, push: { cd: 1500 }, forage: { cd: 8000 }, dash: { cd: 3000 }, jump: { cd: 3000 },
  dive: { cd: 2000, hold: 6000 }, fly: { cd: 3000, hold: 5000 }, shell: { cd: 2000, hold: 6000 },
  spikes: { cd: 3000, hold: 5000 }, burrow: { cd: 4000, hold: 8000 },
  strike: { cd: 2500 }, claw: { cd: 2500 }, grab: { cd: 4000 }, venom: { cd: 4000 },
  fire: { cd: 6000 }, freeze: { cd: 8000 }, shock: { cd: 7000 }, quake: { cd: 8000 }, web: { cd: 8000 },
  poison: { cd: 6000 }, gust: { cd: 6000 }, pull: { cd: 9000 }, heal: { cd: 12000 }, stun: { cd: 9000 },
};
const SLOT = { ability1: 0, diving: 2 }; // the client's ht
const SHOW_MS = 500; // how long an instant ability shows as active

const sendCooldown = (p, slot, ms, active = false) =>
  p.ws.send(updateMessage([["cooldown", [encode("cooldown", { slot, remaining: ms, active })]]]));

// Animals in reach: in front (arc) or all around (ring), never the user or the untouchable.
function targets(lobby, p, { range, front = false }) {
  const a = p.animal;
  const out = [];
  for (const q of lobby.players) {
    const b = q.animal;
    if (!b || q === p) continue;
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
    if (d - b.size / 2 > range) continue;
    if (front && Math.cos(a.angle) * dx + Math.sin(a.angle) * dy < -b.size / 2) continue;
    if (!lobby.canHurt(q, p, Date.now())) continue;
    out.push(q);
  }
  return out;
}

const power = (a) => 10 + a.tier * 1.4; // damage of a strong hit

function hit(lobby, p, q, damage, now, effects = {}) {
  const b = q.animal;
  for (const [k, ms] of Object.entries(effects)) {
    b[k + "Until"] = Math.max(b[k + "Until"] ?? 0, now + ms);
    if (k === "poisoned" || k === "burning" || k === "bleeding") b[k + "By"] = p;
  }
  if (damage) lobby.hurt(q, damage, p, now, DEATH.PLAYER);
}

function shove(q, from, dist) {
  const b = q.animal, d = Math.hypot(b.x - from.x, b.y - from.y) || 1;
  b.x += ((b.x - from.x) / d) * dist;
  b.y += ((b.y - from.y) / d) * dist;
}

// W pressed.
export function startAbility(lobby, p, now) {
  const a = p.animal;
  if (!a || a.fx?.stunned || a.fx?.frozen || p.flight) return;
  const kind = (a.ability ??= effectOf(lobby.abilityName(a)));
  const spec = EFFECTS[kind];
  if (kind === "none") return;
  if (now < (a.abilityReadyAt ?? 0) || a.abilityActive) return;
  const reach = a.size * 0.6 + 60, ring = a.size + 220;
  a.abilityShownUntil = now + SHOW_MS;
  switch (kind) {
    case "push":
      for (const q of targets(lobby, p, { range: reach + 40, front: true })) shove(q, a, 70);
      a.resource = Math.max(0, (a.resource ?? 100) - 4);
      break;
    case "forage":
      lobby.forage(a, 3);
      break;
    case "dash":
      a.boostUntil = now + 400;
      a.ramUntil = now + 400;
      break;
    case "jump":
      a.boostUntil = now + 300;
      a.flying = true;
      a.landAt = now + 700;
      break;
    case "strike":
      for (const q of targets(lobby, p, { range: reach, front: true })) hit(lobby, p, q, power(a), now);
      break;
    case "claw":
      for (const q of targets(lobby, p, { range: reach, front: true })) hit(lobby, p, q, power(a) * 0.8, now, { bleeding: 4000 });
      break;
    case "grab":
      for (const q of targets(lobby, p, { range: reach, front: true })) hit(lobby, p, q, power(a) * 0.6, now, { constricted: 2000, stunned: 2000 });
      break;
    case "venom":
      for (const q of targets(lobby, p, { range: reach + 120, front: true })) hit(lobby, p, q, power(a) * 0.5, now, { poisoned: 5000 });
      break;
    case "fire":
      for (const q of targets(lobby, p, { range: ring, front: true })) hit(lobby, p, q, power(a) * 0.7, now, { burning: 3000 });
      break;
    case "freeze":
      for (const q of targets(lobby, p, { range: ring })) hit(lobby, p, q, power(a) * 0.3, now, { frozen: 2000 });
      break;
    case "shock":
      for (const q of targets(lobby, p, { range: ring })) hit(lobby, p, q, power(a) * 0.8, now, { stunned: 1000 });
      break;
    case "quake":
      for (const q of targets(lobby, p, { range: ring })) (hit(lobby, p, q, power(a) * 0.6, now, { stunned: 1200 }), shove(q, a, 60));
      break;
    case "web":
      for (const q of targets(lobby, p, { range: ring })) hit(lobby, p, q, 0, now, { web: 2500 });
      break;
    case "poison":
      for (const q of targets(lobby, p, { range: ring * 0.8 })) hit(lobby, p, q, 0, now, { poisoned: 3000 });
      break;
    case "gust":
      for (const q of targets(lobby, p, { range: ring * 1.3 })) shove(q, a, 220);
      break;
    case "pull":
      for (const q of targets(lobby, p, { range: ring * 1.4 })) (shove(q, a, -160), hit(lobby, p, q, power(a) * 0.4, now));
      break;
    case "heal":
      a.healingUntil = now + 4000;
      break;
    case "stun":
      for (const q of targets(lobby, p, { range: ring })) if (q.animal.tier <= a.tier) hit(lobby, p, q, 0, now, { stunned: 1500 });
      break;
    case "dive":
      if (lobby.terrainAt(a.x, a.y) !== "water") return lobby.serverMessage(p, "Dive in water!");
    // falls through: dive is held like the others below
    case "fly":
    case "shell":
    case "spikes":
    case "burrow":
      a.abilityActive = kind;
      a.abilityEndsAt = now + spec.hold;
      if (kind === "fly") a.flying = true;
      if (kind === "dive") (a.fx ??= {}).diving = true;
      sendCooldown(p, SLOT.ability1, spec.hold, true);
      return;
  }
  a.abilityReadyAt = now + spec.cd;
  sendCooldown(p, SLOT.ability1, spec.cd);
}

// W released (or a held ability ran out).
export function stopAbility(lobby, p, now) {
  const a = p.animal;
  if (!a?.abilityActive) return;
  const kind = a.abilityActive;
  a.abilityActive = null;
  if (kind === "fly") a.flying = false;
  if (kind === "dive" && a.fx) a.fx.diving = false;
  a.abilityReadyAt = now + EFFECTS[kind].cd;
  sendCooldown(p, SLOT.ability1, EFFECTS[kind].cd);
}

// Diving with the dive button: water animals in water. Oxygen runs down while under.
export function startDiving(lobby, p, now) {
  const a = p.animal;
  if (!a || now < (a.diveReadyAt ?? 0) || lobby.terrainAt(a.x, a.y) !== "water") return;
  const cfg = lobby.configOf(a);
  if (!(cfg.terrainSpeedComfort?.water >= 1)) return lobby.serverMessage(p, "Only water animals can dive.");
  (a.fx ??= {}).diving = true;
  a.divingSince = now;
  sendCooldown(p, SLOT.diving, 0, true);
}

export function stopDiving(lobby, p, now) {
  const a = p.animal;
  if (!a?.fx?.diving || a.abilityActive === "dive") return;
  a.fx.diving = false;
  a.diveReadyAt = now + (lobby.configOf(a).divingCooldown ?? 3000);
  sendCooldown(p, SLOT.diving, lobby.configOf(a).divingCooldown ?? 3000);
}

// Climbing animals near a tree go up it (safe from animals that can't climb) or come down.
export function toggleClimb(lobby, p) {
  const a = p.animal;
  if (!a || !lobby.configOf(a).canClimbTree) return;
  if (a.inTree) return void (a.inTree = false);
  const tree = [...lobby.entities.values()].find((e) => e.type === "tree" && Math.hypot(e.x - a.x, e.y - a.y) < e.size / 2);
  if (!tree) return lobby.serverMessage(p, "Get to a tree first!");
  a.inTree = true;
  Object.assign(a, { x: tree.x, y: tree.y });
}

// Every tick: held abilities running out, landing, rams, spikes, oxygen, the "using it" flag.
export function abilityStep(lobby, p, now, dt) {
  const a = p.animal;
  const fx = (a.fx ??= {});
  if (a.abilityActive && now >= a.abilityEndsAt) stopAbility(lobby, p, now);
  if (a.landAt && now >= a.landAt) (a.flying = false), (a.landAt = null);
  if (a.ramUntil > now)
    for (const q of targets(lobby, p, { range: a.size * 0.55 + 10, front: true }))
      if (!q.animal.rammedUntil || q.animal.rammedUntil < now) (q.animal.rammedUntil = now + 400), hit(lobby, p, q, power(a) * 0.7, now), shove(q, a, 80);
  if (a.abilityActive === "spikes")
    for (const q of targets(lobby, p, { range: a.size * 0.55 + 10 })) if (now >= (q.animal.spikedAt ?? 0)) (q.animal.spikedAt = now + 500), hit(lobby, p, q, 8, now);
  fx.shell = a.abilityActive === "shell" || a.abilityActive === "spikes";
  fx.hidden = a.abilityActive === "burrow";
  fx.ability1 = !!a.abilityActive || now < (a.abilityShownUntil ?? 0);
  a.abilitySpeed = fx.shell ? 0 : fx.hidden ? 0.35 : a.inTree ? 0 : 1;
  // oxygen under water
  if (fx.diving) {
    a.oxygen = Math.max(0, (a.oxygen ?? 100) - (lobby.configOf(a).oxygenDecreaseAmount ?? 10) * dt);
    if (a.oxygen <= 0 || lobby.terrainAt(a.x, a.y) !== "water") (a.abilityActive === "dive" ? stopAbility(lobby, p, now) : stopDiving(lobby, p, now));
  } else a.oxygen = Math.min(100, (a.oxygen ?? 100) + 20 * dt);
  const shown = Math.round(a.oxygen);
  if (shown !== p.shownOxygen) {
    p.shownOxygen = shown;
    p.ws.send(updateMessage([["oxygen", [encode("oxygen", { oxygen: shown })]]]));
  }
}
