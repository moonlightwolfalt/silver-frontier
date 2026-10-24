// Game modes beyond FFA and Party, all built on the client's own 1v1 arena (e_):
//   - casual 1v1s: tier 15+ players (and staff) target someone with the 1v1 button; if they
//     accept, both fight in an arena. The loser is eaten, like in mope.io. Ratings don't change.
//   - RANKED: a server mode with a matchmaking queue. Pick a tier 15-17 fighter, get matched
//     with the closest rating, win or lose Elo. Ranks run Bronze to Champion.
//   - tournaments: staff open a 4/8/16 bracket with /tournament, players /join, and every round
//     is played in arenas. Tournament fights aren't lethal; the champion gets the prize.
//   - BR (Battle Royale): rounds start once two players are in. A zone (an arena ring with no
//     fighters) shrinks over four minutes and hurts anyone outside; last animal standing wins.
//   - TEAMS: Red and Blue, names in team colours, no friendly fire, team scores announced.
//   - SANDBOX: nobody can be hurt, the water bar doesn't drain, nothing counts for the boards.
import { MAP, E, Lr, DEATH, encode, record, updateMessage, writeArenaSync, getRecords, getProgress } from "./game-server.js";

export { MODE_LIST, MODE_BY_SLUG } from "./mode-list.js";

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fmt = (n) => Math.round(n).toLocaleString("en-US");
const humans = (lobby) => [...lobby.players].filter((p) => p.animal);
const tell = (lobby, message) => { for (const p of lobby.players) lobby.serverMessage(p, message); };
const cooldown = (p, slot, ms) =>
  p.ws.send(updateMessage([["cooldown", [encode("cooldown", { slot, remaining: ms, active: false })]]]));
const ARENA_SLOT = 3; // the client's ht.arena

// ---------- arenas ----------

const COUNTDOWN_MS = 3000;
const FIGHT_MS = 90_000;
const RESULT_MS = 2500;

export class Arena {
  constructor(lobby, p1, p2, { kind = "casual", at = null, onEnd = null } = {}) {
    Object.assign(this, { lobby, p1, p2, kind, onEnd, phase: "countdown", start: Date.now(), ticks: 0 });
    const a = p1.animal, b = p2.animal;
    const size = Math.min(1600, 560 + 3.2 * Math.max(a.size, b.size));
    const x = clamp(at?.x ?? (a.x + b.x) / 2, size / 2 + 60, MAP.x - size / 2 - 60);
    const y = clamp(at?.y ?? (a.y + b.y) / 2, size / 2 + 60, MAP.y - size / 2 - 60);
    for (const [p, side] of [[p1, -1], [p2, 1]]) {
      const an = p.animal;
      lobby.unloadSlingshot(p);
      p.flight = null;
      an.flying = false;
      p.arena = this;
      p.menu = [];
      Object.assign(an, { x: x + side * size * 0.3, y, vx: 0, vy: 0, health: 100, angle: side < 0 ? 0 : Math.PI });
      an.immuneUntil = this.start + COUNTDOWN_MS;
      p.target = { x: an.x, y: an.y };
    }
    this.entity = lobby.addEntity({
      type: "arena", species: 0, biome: E.land, x, y, size, angle: 0, p1, p2,
      timer: FIGHT_MS / 1000, score1: 0, score2: 0, wall: 0, message: "3", inner: 0, outer: 0,
    });
    lobby.arenas.add(this);
  }

  other(p) {
    return p === this.p1 ? this.p2 : p === this.p2 ? this.p1 : null;
  }

  step(now, out) {
    const e = this.entity, t = now - this.start;
    if (this.phase === "countdown") {
      e.message = t < COUNTDOWN_MS ? String(Math.ceil((COUNTDOWN_MS - t) / 1000)) : "FIGHT!";
      e.inner = clamp(t / COUNTDOWN_MS, 0, 1);
      if (t >= COUNTDOWN_MS) this.phase = "fight";
    } else if (this.phase === "fight") {
      const f = t - COUNTDOWN_MS;
      if (f > 1000) e.message = "";
      e.timer = Math.ceil((FIGHT_MS - f) / 1000);
      e.outer = clamp(f / FIGHT_MS, 0, 1);
      e.wall = (e.size / 2) * 0.45 * e.outer; // the ring closes in as time runs out
      e.score1 = 100 - (this.p2.animal?.health ?? 0);
      e.score2 = 100 - (this.p1.animal?.health ?? 0);
      if (f >= FIGHT_MS) this.timeUp();
    } else if (now >= this.removeAt) return this.remove();
    // fighters stay inside the ring, everyone else stays out
    const r = e.size / 2 - e.wall;
    for (const p of this.lobby.players) {
      const a = p.animal;
      if (!a) continue;
      const dx = a.x - e.x, dy = a.y - e.y, d = Math.hypot(dx, dy) || 1;
      if (p.arena === this && this.phase !== "done") {
        const max = Math.max(0, r - a.size / 2);
        if (d > max) (a.x = e.x + (dx / d) * max), (a.y = e.y + (dy / d) * max);
      } else if (!p.arena && d < e.size / 2 + a.size / 2) {
        const min = e.size / 2 + a.size / 2;
        (a.x = e.x + (dx / d) * min), (a.y = e.y + (dy / d) * min);
      }
    }
    if (this.ticks++ % 4 === 0) out.push(record((w) => writeArenaSync(w, e)));
  }

  timeUp() {
    const h1 = this.p1.animal?.health ?? 0, h2 = this.p2.animal?.health ?? 0;
    if (h1 === h2) return this.finish(this.kind === "tournament" ? (Math.random() < 0.5 ? this.p1 : this.p2) : null, "time");
    this.finish(h1 > h2 ? this.p1 : this.p2, "time");
  }

  // Ends the fight: winner (or null for a draw) and why ("ko", "time", "forfeit").
  finish(winner, why) {
    if (this.phase === "done") return;
    this.phase = "done";
    this.removeAt = Date.now() + RESULT_MS;
    const loser = this.other(winner);
    const e = this.entity;
    if (winner) {
      winner.wins = (winner.wins ?? 0) + 1;
      if (winner.animal) winner.animal.wins = winner.wins;
      getProgress()?.arenaWin(winner);
      const bonus = this.kind === "casual" && winner.animal ? this.lobby.foodXP(winner.animal) * 5 : 0;
      if (bonus) (winner.xp += bonus), this.lobby.sendXP(winner);
      this.lobby.giveCoins(winner, this.kind === "ranked" ? 20 : this.kind === "casual" ? 10 : 0, "1v1");
      e.message = bonus ? `BONUS${bonus}` : `${winner.name || "Winner"} wins!`;
    } else e.message = "Draw!";
    for (const p of [this.p1, this.p2]) {
      p.arena = null;
      if (p.animal) p.animal.immuneUntil = Date.now() + 2000;
    }
    this.lobby.broadcast(updateMessage([["position", [record((w) => writeArenaSync(w, e))]]]));
    this.onEnd?.(winner, loser, why);
  }

  remove() {
    this.lobby.removeEntity(this.entity.id);
    this.lobby.arenas.delete(this);
  }
}

// ---------- casual 1v1 requests ----------

export function arenaRequest(lobby, p, targetId) {
  const now = Date.now();
  const q = [...lobby.players].find((o) => o.animal?.id === targetId);
  if (!p.animal || !q || q === p) return;
  if (!["FFA", "PARTY"].includes(lobby.mode)) return lobby.serverMessage(p, "1v1 requests work in FFA and Party. Try the 1V1 RANKED mode!");
  if (p.arena || q.arena) return lobby.serverMessage(p, "One of you is already in a 1v1.");
  if (p.animal.tier < 15 && (p.role ?? 0) < 4) return lobby.serverMessage(p, "1v1s are for tier 15 and up.");
  if (q.animal.tier < 15) return lobby.serverMessage(p, `${q.name || "They"} must be tier 15 or higher.`);
  if (now < (p.arenaRequestAt ?? 0) + 10_000) return;
  p.arenaRequestAt = now;
  q.arenaInvite = { from: p, until: now + 15_000 };
  q.ws.send(updateMessage([["arenaRequest", [encode("arenaRequest", { id: p.animal.id, xp: Math.min(2 ** 32 - 1, p.xp) })]]]));
  cooldown(p, ARENA_SLOT, 10_000);
  lobby.serverMessage(p, `1v1 request sent to ${q.name || "them"}.`);
  if (q.bot) setTimeout(() => lobby.timer && arenaResponse(lobby, q, !q.boss && Math.random() < 0.7), 1500); // bots usually accept
}

export function arenaResponse(lobby, q, accepted) {
  const inv = q.arenaInvite;
  q.arenaInvite = null;
  if (!inv || Date.now() > inv.until) return;
  const p = inv.from;
  if (!accepted) return lobby.players.has(p) && lobby.serverMessage(p, `${q.name || "They"} declined your 1v1.`);
  if (!p.animal || !q.animal || p.arena || q.arena || !lobby.players.has(p)) return;
  new Arena(lobby, p, q, { kind: "casual" });
}

// ---------- ranked ----------

export const RANKS = [[1700, "Champion"], [1550, "Diamond"], [1400, "Platinum"], [1250, "Gold"], [1100, "Silver"], [0, "Bronze"]];
export const rankOf = (rating) => RANKS.find(([min]) => rating >= min)[1];
const K = 32;

function rankedMatchmaking(lobby, now) {
  const records = getRecords();
  const queue = humans(lobby)
    .filter((p) => !p.arena && p.animal.tier >= 15 && !p.menu.length && now >= (p.rankedReadyAt ?? 0))
    .map((p) => ({ p, rating: records?.rating(p) ?? 1000, waited: (now - (p.queuedAt ??= now)) / 1000 }))
    .sort((a, b) => a.rating - b.rating);
  for (let i = 0; i + 1 < queue.length; i++) {
    const a = queue[i], b = queue[i + 1];
    const window = 100 + 25 * Math.min(a.waited, b.waited);
    if (Math.abs(a.rating - b.rating) > window) continue;
    i++;
    a.p.queuedAt = b.p.queuedAt = null;
    new Arena(lobby, a.p, b.p, { kind: "ranked", onEnd: (w, l) => rankedResult(lobby, a.p, b.p, w) });
  }
}

function rankedResult(lobby, p1, p2, winner) {
  const records = getRecords();
  const r1 = records?.rating(p1) ?? 1000, r2 = records?.rating(p2) ?? 1000;
  const expected1 = 1 / (1 + 10 ** ((r2 - r1) / 400));
  const score1 = winner === p1 ? 1 : winner === p2 ? 0 : 0.5;
  const d = Math.round(K * (score1 - expected1));
  for (const [p, before, delta] of [[p1, r1, d], [p2, r2, -d]]) {
    const after = Math.max(0, before + delta);
    if (!p.bot) records?.setRating(p, after);
    getProgress()?.rating(p, after);
    p.rankedReadyAt = Date.now() + 3000;
    if (lobby.players.has(p))
      lobby.serverMessage(p, `${winner === p ? "Victory!" : winner ? "Defeat." : "Draw."} Rating ${after} (${delta >= 0 ? "+" : ""}${delta}) · ${rankOf(after)}`);
  }
}

// ---------- tournaments (staff-run) ----------

function tournamentRound(lobby) {
  const t = lobby.tournament;
  const present = (p) => lobby.players.has(p) && p.animal;
  t.round++;
  t.pending = 0;
  const players = t.alive.filter(present);
  t.alive = players;
  if (players.length <= 1) return tournamentDone(lobby, players[0] ?? null);
  const pairs = [];
  for (let i = 0; i < players.length; i += 2) pairs.push([players[i], players[i + 1] ?? null]);
  tell(lobby, `Tournament round ${t.round}: ${pairs.map(([a, b]) => `${a.name || "?"} vs ${b ? b.name || "?" : "(bye)"}`).join(" · ")}`);
  const next = [];
  pairs.forEach(([a, b], i) => {
    if (!b) return next.push(a);
    t.pending++;
    const spot = { x: MAP.x / 2 + ((i % 4) - 1.5) * 1700, y: MAP.y / 2 + (Math.floor(i / 4) - 0.5) * 1700 };
    new Arena(lobby, a, b, {
      kind: "tournament", at: spot,
      onEnd: (w) => {
        next.push(w ?? a);
        if (--t.pending === 0) setTimeout(() => lobby.tournament === t && ((t.alive = next), tournamentRound(lobby)), 3000);
      },
    });
  });
  if (!t.pending) setTimeout(() => lobby.tournament === t && ((t.alive = next), tournamentRound(lobby)), 1000);
}

function tournamentDone(lobby, champion) {
  const t = lobby.tournament;
  lobby.tournament = null;
  if (!champion) return tell(lobby, "The tournament ended without a winner.");
  champion.xp += t.prize;
  lobby.sendXP(champion);
  lobby.checkProgress(champion);
  if (!champion.bot) getRecords()?.addCount("tournament_wins", champion);
  lobby.giveCoins(champion, 200, "tournament");
  getProgress()?.tournamentWin(champion);
  tell(lobby, `🏆 ${champion.name || "Someone"} won the tournament!${t.prize ? ` +${fmt(t.prize)} XP` : ""}`);
}

// /tournament open <4|8|16> [prize XP] | start | cancel | status, and /join
export function tournamentCommand(ctx, [sub, ...args]) {
  const { lobby, player } = ctx;
  const t = lobby.tournament;
  const staff = (player.role ?? 0) >= 4;
  switch (sub) {
    case "open": {
      if (!staff) throw new Error("only staff can open a tournament");
      if (t) throw new Error("a tournament is already on");
      const size = Number(args[0]) || 8;
      if (![4, 8, 16].includes(size)) throw new Error("size: 4, 8 or 16");
      lobby.tournament = { size, prize: Math.max(0, Number(args[1]) || 0), players: [], state: "open", round: 0 };
      return tell(lobby, `Tournament open for ${size} players${lobby.tournament.prize ? `, prize ${fmt(lobby.tournament.prize)} XP` : ""}! Type /join to enter.`);
    }
    case "join":
      return tournamentJoin(ctx);
    case "start": {
      if (!staff) throw new Error("only staff can start it");
      if (!t || t.state !== "open") throw new Error("no open tournament");
      if (t.players.length < 2) throw new Error("needs at least 2 players");
      t.state = "running";
      t.alive = [...t.players].sort(() => Math.random() - 0.5);
      tell(lobby, `The tournament begins with ${t.players.length} players!`);
      return tournamentRound(lobby);
    }
    case "cancel":
      if (!staff) throw new Error("only staff can cancel it");
      if (!t) throw new Error("no tournament");
      lobby.tournament = null;
      for (const a of [...lobby.arenas]) if (a.kind === "tournament") a.finish(null, "cancel");
      return tell(lobby, "The tournament was cancelled.");
    default:
      if (!t) return lobby.serverMessage(player, "No tournament right now.");
      return lobby.serverMessage(player, t.state === "open"
        ? `Tournament open: ${t.players.length}/${t.size} joined (${t.players.map((p) => p.name || "?").join(", ") || "nobody yet"}). /join to enter.`
        : `Tournament round ${t.round}: ${t.alive.length} left.`);
  }
}

export function tournamentJoin({ lobby, player }) {
  const t = lobby.tournament;
  if (!t || t.state !== "open") throw new Error("no tournament is taking players");
  if (!player.animal) throw new Error("spawn first");
  if (t.players.includes(player)) throw new Error("you're already in");
  if (t.players.length >= t.size) throw new Error("it's full");
  t.players.push(player);
  tell(lobby, `${player.name || "Someone"} joined the tournament (${t.players.length}/${t.size}).`);
}

// ---------- Battle Royale ----------

const BR_LOBBY_MS = 15_000;
const BR_ZONE_MS = 240_000;
const BR_OVER_MS = 10_000;
const BR_ZONE_MIN = 600;
const BR_ZONE_DAMAGE = 6; // health per second outside

function brStep(lobby, now, out) {
  const br = (lobby.br ??= { phase: "waiting", alive: new Set() });
  const playing = humans(lobby);
  if (br.phase === "waiting") {
    if (playing.length < 2) {
      br.startAt = null;
      if (lobby.ticks % 200 === 0) tell(lobby, "Battle Royale: waiting for another player…");
      return;
    }
    br.startAt ??= now + BR_LOBBY_MS;
    const left = Math.ceil((br.startAt - now) / 1000);
    if (lobby.ticks % 100 === 0 && left > 0) tell(lobby, `Battle Royale starts in ${left}s!`);
    if (now < br.startAt) return;
    // start: the zone covers the map and closes on a random point
    const size = Math.ceil(Math.hypot(MAP.x, MAP.y)) + 200;
    const cx = MAP.x * (0.3 + Math.random() * 0.4), cy = MAP.y * (0.3 + Math.random() * 0.4);
    br.zone = lobby.addEntity({
      type: "arena", species: 0, biome: E.land, x: cx, y: cy, size, angle: 0, p1: null, p2: null,
      timer: BR_ZONE_MS / 1000, score1: 0, score2: 0, wall: 0, message: "", inner: 0, outer: 0,
    });
    br.phase = "running";
    br.started = now;
    br.alive = new Set(playing);
    for (const p of playing) p.animal.immuneUntil = now + 3000;
    return tell(lobby, `Battle Royale! ${playing.length} players. Stay inside the ring; last animal standing wins.`);
  }
  if (br.phase === "running") {
    for (const p of br.alive) if (!lobby.players.has(p) || !p.animal) br.alive.delete(p);
    const z = br.zone;
    const progress = clamp((now - br.started) / BR_ZONE_MS, 0, 1);
    const radius = z.size / 2 - (z.size / 2 - BR_ZONE_MIN / 2) * progress;
    z.wall = z.size / 2 - radius;
    z.timer = Math.ceil((BR_ZONE_MS - (now - br.started)) / 1000);
    z.outer = progress;
    z.message = `Players left: ${br.alive.size}`;
    for (const p of playing)
      if (Math.hypot(p.animal.x - z.x, p.animal.y - z.y) > radius) lobby.hurt(p, BR_ZONE_DAMAGE / 20, null, now, DEATH.ENVIRONMENT);
    if (lobby.ticks % 10 === 0) out.push(record((w) => writeArenaSync(w, z)));
    if (br.alive.size <= 1) {
      const [winner] = br.alive;
      br.phase = "over";
      br.overAt = now + BR_OVER_MS;
      z.message = winner ? `${winner.name || "Someone"} wins!` : "Nobody survived!";
      out.push(record((w) => writeArenaSync(w, z)));
      if (winner) {
        winner.wins = (winner.wins ?? 0) + 1;
        if (!winner.bot) getRecords()?.addCount("br_wins", winner);
        lobby.giveCoins(winner, 50, "br");
        getProgress()?.brWin(winner);
        winner.xp += lobby.foodXP(winner.animal) * 20;
        lobby.sendXP(winner);
      }
      tell(lobby, winner ? `🏆 ${winner.name || "Someone"} wins the Battle Royale! Next round in 10 seconds.` : "Nobody survived! Next round in 10 seconds.");
    }
    return;
  }
  if (br.phase === "over" && now >= br.overAt) {
    lobby.removeEntity(br.zone.id);
    lobby.br = { phase: "waiting", alive: new Set() };
  }
}

// ---------- Teams ----------

export const TEAMS = { Red: 0xe04848, Blue: 0x3f86f0 };

export function pickTeam(lobby, p) {
  if (p.team) return;
  const count = (name) => [...lobby.players].filter((o) => o.team === name).length;
  p.team = count("Red") <= count("Blue") ? "Red" : "Blue";
}

function teamScores(lobby) {
  const sum = (name) => [...lobby.players].filter((o) => o.team === name && o.animal).reduce((s, o) => s + o.xp, 0);
  return `Red ${fmt(sum("Red"))} XP — Blue ${fmt(sum("Blue"))} XP`;
}
export const teamCommand = ({ lobby, player }) =>
  lobby.serverMessage(player, lobby.mode === "TEAMS" ? `You're on ${player.team ?? "no team"}. ${teamScores(lobby)}` : "This isn't a Teams server.");

// ---------- hooks used by game-server.js ----------

// Every tick, after movement and bites. `out` collects position records for this tick.
export function modeTick(lobby, now, out) {
  for (const a of [...lobby.arenas]) a.step(now, out);
  if (lobby.mode === "RANKED" && lobby.ticks % 20 === 0) rankedMatchmaking(lobby, now);
  if (lobby.mode === "BR") brStep(lobby, now, out);
  if (lobby.mode === "TEAMS" && lobby.ticks % 600 === 0 && humans(lobby).length) tell(lobby, `Team scores: ${teamScores(lobby)}`);
}

// Right after a player spawns from the menu (startGameSession).
export function onSpawn(lobby, p) {
  if (lobby.mode === "RANKED") {
    const req = Lr[14].requiredXP;
    if (p.xp < req) (p.xp = req), lobby.sendXP(p);
    lobby.showTier(p, 15, true);
    const rating = getRecords()?.rating(p) ?? 1000;
    lobby.serverMessage(p, `Ranked 1v1: pick a tier 15-17 fighter (▲/▼ for more), then you're matched automatically. Rating ${rating} · ${rankOf(rating)}`);
  } else if (lobby.mode === "SANDBOX") lobby.serverMessage(p, "Sandbox: use ▲/▼ to try any animal. Nobody can be hurt here.");
  else if (lobby.mode === "TEAMS") lobby.serverMessage(p, `You're on team ${p.team}! Teammates can't hurt each other.`);
  else if (lobby.mode === "BR")
    lobby.serverMessage(p, lobby.br?.phase === "running" ? "A round is under way. You'll be in the next one!"
      : "Battle Royale: a round starts 15 s after two players are in. Stay inside the ring; last animal standing wins.");
}

// Before a hit would kill p. True means the death is prevented (tournament fights).
export function beforeLethal(lobby, p, q) {
  const arena = p.arena;
  if (!arena || arena.kind !== "tournament" || arena.phase !== "fight") return false;
  p.animal.health = 100;
  arena.finish(arena.other(p), "ko");
  return true;
}

// p died (q is the killer, if any) or left the lobby.
export function onGone(lobby, p) {
  if (p.arena) p.arena.finish(p.arena.other(p), "forfeit");
  p.arenaInvite = null;
  p.queuedAt = null;
  if (lobby.br) lobby.br.alive.delete(p);
}
