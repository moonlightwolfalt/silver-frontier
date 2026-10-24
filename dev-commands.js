// Developer / staff commands for the local game server.
//
// Two entry points reach runCommand():
//   - chat lines starting with "/" (any player can use /help; the rest need a staff role)
//   - the client's built-in staff tools, unlocked in its UI for accounts with role >= MODERATOR:
//     admin user list, teleport to/bring, observe (targetPlayer), kick, ban, move/destroy.
//
// Roles (the client's own enum): USER 0, MODERATOR 1, TRUSTED_MODERATOR 2, EVENT_TEAM 3, ADMIN 4,
// DEVELOPER 5. Each command lists the lowest role allowed to run it.

import { PUMPKINS, pickPumpkin } from "./pumpkins.js";
import { MAX_XP } from "./limits.js";
import { tournamentCommand, tournamentJoin, teamCommand, rankOf, arenaRequest } from "./modes.js";

const COMMANDS = {
  help: { role: 0, usage: "/help", run: help },
  top: { role: 0, usage: "/top  (worldwide records)", run: top },
  players: { role: 1, usage: "/players", run: players },
  animal: { role: 4, usage: "/animal <name> [subspecies]", run: animal },
  tier: { role: 4, usage: "/tier <1-17>  (opens that tier's upgrade menu)", run: tier },
  xp: { role: 4, usage: "/xp <amount>  (up to 10 trillion; upgrades follow, tier 17 at 1T)", run: xp },
  size: { role: 4, usage: "/size <size> | /size auto  (auto: size follows XP)", run: size },
  speed: { role: 4, usage: "/speed <multiplier>", run: speed },
  zoom: { role: 4, usage: "/zoom <0.2-15>", run: zoom },
  god: { role: 4, usage: "/god  (toggle)", run: god },
  tp: { role: 4, usage: "/tp <x> <y> | /tp <player>", run: tp },
  face: { role: 4, usage: "/face <degrees>  (0 = right, 90 = down; aims /shoot)", run: face },
  tournament: { role: 0, usage: "/tournament [open <4|8|16> [prize XP] | start | cancel]  (staff run it; anyone can check it)", run: tournamentCommand },
  join: { role: 0, usage: "/join  (enter the open tournament)", run: tournamentJoin },
  team: { role: 0, usage: "/team  (your team and the team scores)", run: teamCommand },
  "1v1": { role: 0, usage: "/1v1 <player>  (send a 1v1 request; tier 15+)", run: duel },
  rank: { role: 0, usage: "/rank  (your ranked 1v1 rating)", run: rank },
  layer: { role: 4, usage: "/layer <surface|underground|sky|space>  (go to another layer world)", run: layer },
  pos: { role: 1, usage: "/pos  (your position, and the nearest hole, cake and slingshot)", run: pos },
  bring: { role: 4, usage: "/bring <player>", run: bring },
  spawn: { role: 4, usage: "/spawn <food> [count]", run: spawnFood },
  shoot: { role: 4, usage: "/shoot [variant] [count]  (fires pumpkins the way you face; default random variant)", run: shoot },
  pumpkin: { role: 4, usage: "/pumpkin <variant> [count]  (normal jack gold emerald amber sapphire ruby amethyst diamond black_hole onyx)", run: pumpkin },
  clearfood: { role: 4, usage: "/clearfood", run: clearFood },
  kill: { role: 4, usage: "/kill [player]", run: kill },
  kick: { role: 1, usage: "/kick <player>", run: kick },
  ban: { role: 2, usage: "/ban <player> [minutes]", run: ban },
  unban: { role: 2, usage: "/unban <email>", run: unban },
  announce: { role: 3, usage: "/announce <message>", run: announce },
  coins: { role: 5, usage: "/coins <amount> [email]", run: (c, a) => wallet(c, a, "coins") },
  gems: { role: 5, usage: "/gems <amount> [email]", run: (c, a) => wallet(c, a, "gems") },
  role: { role: 5, usage: "/role <email> <0-5>", run: setRole },
};

export function runCommand(ctx, input) {
  const { player } = ctx;
  if (typeof input === "object") return runTool(ctx, input);
  const [name, ...args] = input.slice(1).trim().split(/\s+/);
  const cmd = COMMANDS[name?.toLowerCase()];
  if (!cmd) return reply(ctx, `Unknown command /${name}. Try /help`);
  if ((player.role ?? 0) < cmd.role) return reply(ctx, `You need a higher role for /${name}.`);
  try {
    cmd.run(ctx, args);
  } catch (e) {
    reply(ctx, `/${name} failed: ${e.message}`);
  }
}

const reply = (ctx, message) => ctx.lobby.serverMessage(ctx.player, message);

function findPlayer(ctx, query) {
  if (!query) return null;
  const q = query.toLowerCase();
  const all = ctx.allPlayers().filter((p) => p.animal);
  return (
    all.find((p) => String(p.animal.id) === q) ??
    all.find((p) => p.name.toLowerCase() === q) ??
    all.find((p) => p.account?.email === q) ??
    all.find((p) => p.name.toLowerCase().startsWith(q))
  );
}

const needAnimal = (ctx) => {
  if (!ctx.player.animal) throw new Error("spawn first");
  return ctx.player.animal;
};

function help(ctx) {
  const lines = Object.values(COMMANDS)
    .filter((c) => (ctx.player.role ?? 0) >= c.role)
    .map((c) => c.usage);
  reply(ctx, lines.join("  ·  "));
}

function top(ctx) {
  const xp = ctx.records?.top("most_xp");
  const goals = ctx.records?.top("pumpkin_goals");
  reply(ctx, [
    `Most XP worldwide: ${xp ? `${xp.name} (${xp.value.toLocaleString("en-US")} XP)` : "nobody yet"}`,
    `Most pumpkin goals: ${goals ? `${goals.name} (${goals.value})` : "nobody yet"}`,
  ].join("  ·  "));
}

function players(ctx) {
  const list = ctx.allPlayers().filter((p) => p.animal);
  reply(ctx, list.map((p) => `${p.animal.id}:${p.name || "(no name)"} [${p.lobby.region.id}] ${p.animal.slug}`).join(", ") || "nobody is playing");
}

function animal(ctx, [slug, sub]) {
  const { M } = ctx.game;
  if (!M[slug]) throw new Error(`no animal "${slug}"`);
  needAnimal(ctx);
  ctx.lobby.switchAnimal(ctx.player, slug, Number(sub) || 0);
}

function tier(ctx, [n]) {
  needAnimal(ctx);
  ctx.lobby.showTier(ctx.player, Number(n));
}

function xp(ctx, [n]) {
  ctx.player.xp = Math.min(MAX_XP, Math.max(0, Number(n) || 0));
  ctx.lobby.sendXP(ctx.player);
  ctx.lobby.checkProgress(ctx.player);
}

function size(ctx, [n]) {
  needAnimal(ctx);
  ctx.player.fixedSize = n === "auto" ? null : Math.min(256, Math.max(5, Number(n) || 30));
}

function speed(ctx, [n]) {
  needAnimal(ctx).speed = Math.min(20, Math.max(0.1, Number(n) || 1));
}

function zoom(ctx, [n]) {
  ctx.player.zoom = Math.min(15, Math.max(0.2, Number(n) || 1));
}

function god(ctx) {
  const a = needAnimal(ctx);
  a.godMode = !a.godMode;
  reply(ctx, `God mode ${a.godMode ? "on" : "off"}`);
}

function moveAnimal(a, x, y) {
  a.x = x;
  a.y = y;
}

function face(ctx, [deg]) {
  const a = needAnimal(ctx);
  a.angle = ((((Number(deg) || 0) % 360) + 360) % 360) * (Math.PI / 180);
  a.vx = a.vy = 0;
  ctx.player.target = { x: a.x, y: a.y };
}

function duel(ctx, [name]) {
  const q = [...ctx.lobby.players].find((o) => o.animal && o.name.toLowerCase() === String(name ?? "").toLowerCase());
  if (!q) throw new Error(`no player "${name}" here`);
  arenaRequest(ctx.lobby, ctx.player, q.animal.id);
}

function rank(ctx) {
  const r = ctx.records?.rating(ctx.player) ?? 1000;
  reply(ctx, `Ranked 1v1 rating: ${r} · ${rankOf(r)}`);
}

function layer(ctx, [name]) {
  const a = needAnimal(ctx);
  const names = ["surface", "underground", "sky", "space"];
  if (!names.includes(name)) throw new Error(`layers: ${names.join(", ")}`);
  ctx.lobby.transfer(ctx.player, name, { at: { x: a.x, y: a.y } });
}

function pos(ctx) {
  const a = needAnimal(ctx);
  const nearest = (list) => [...list].sort((e1, e2) => Math.hypot(e1.x - a.x, e1.y - a.y) - Math.hypot(e2.x - a.x, e2.y - a.y))[0];
  const at = (label, e, extra = "") => (e ? `  ·  ${label}: ${Math.round(e.x)}, ${Math.round(e.y)}${extra}` : "");
  const sling = nearest(ctx.lobby.slingshots);
  reply(ctx, `You: ${Math.round(a.x)}, ${Math.round(a.y)}` + at("hole", nearest(ctx.lobby.holes)) + at("cake", nearest(ctx.lobby.cakes)) +
    at("slingshot", sling, sling ? ` facing ${Math.round((sling.angle * 180) / Math.PI)}°` : ""));
}

function tp(ctx, [a, b]) {
  const me = needAnimal(ctx);
  if (b !== undefined) {
    moveAnimal(me, Number(a), Number(b));
    ctx.player.target = { x: me.x, y: me.y };
    return;
  }
  const other = findPlayer(ctx, a);
  if (!other) throw new Error(`no player "${a}"`);
  if (other.lobby !== ctx.lobby) throw new Error(`${other.name} is in ${other.lobby.region.id}`);
  moveAnimal(me, other.animal.x, other.animal.y);
  ctx.player.target = { x: me.x, y: me.y };
}

function bring(ctx, [q]) {
  const me = needAnimal(ctx);
  const other = findPlayer(ctx, q);
  if (!other || other.lobby !== ctx.lobby) throw new Error(`no player "${q}" here`);
  moveAnimal(other.animal, me.x, me.y);
  other.target = { x: me.x, y: me.y };
}

function spawnFood(ctx, [name, count]) {
  const { D, E } = ctx.game;
  if (D[name] === undefined || typeof D[name] !== "number") throw new Error(`no food "${name}"`);
  const me = needAnimal(ctx);
  const n = Math.min(100, Math.max(1, Number(count) || 1));
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, d = 40 + Math.random() * 120;
    ctx.lobby.addEntity({ type: "food", species: D[name], biome: me.biomeHere ?? E.land, x: me.x + Math.cos(a) * d, y: me.y + Math.sin(a) * d, size: 20 });
  }
}

function pumpkin(ctx, [name, count]) {
  const variant = PUMPKINS.findIndex((p) => p.id === String(name).toLowerCase());
  if (variant < 0) throw new Error(`no pumpkin "${name}"`);
  const me = needAnimal(ctx);
  const n = Math.min(20, Math.max(1, Number(count) || 1));
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    ctx.lobby.spawnPumpkin(true, variant, { x: me.x + Math.cos(a) * 140, y: me.y + Math.sin(a) * 140 });
  }
}

function shoot(ctx, [name, count]) {
  needAnimal(ctx);
  let variant = null;
  if (name && isNaN(Number(name))) {
    variant = PUMPKINS.findIndex((p) => p.id === name.toLowerCase());
    if (variant < 0) throw new Error(`no pumpkin "${name}"`);
  } else if (name) count = name;
  const n = Math.min(12, Math.max(1, Number(count) || 1));
  for (let i = 0; i < n; i++) {
    const spread = n === 1 ? 0 : (i / (n - 1) - 0.5) * 0.8; // fan out up to ±23°
    ctx.lobby.shootPumpkin(ctx.player, variant ?? pickPumpkin(), spread);
  }
}

function clearFood(ctx) {
  for (const e of [...ctx.lobby.entities.values()]) if (e.type === "food") ctx.lobby.removeEntity(e.id);
}

function kill(ctx, [q]) {
  const target = q ? findPlayer(ctx, q) : ctx.player;
  if (!target) throw new Error(`no player "${q}"`);
  target.lobby.despawn(target);
}

function kick(ctx, [q]) {
  const target = findPlayer(ctx, q);
  if (!target) throw new Error(`no player "${q}"`);
  target.ws.close(4000, "kicked");
}

function ban(ctx, [q, minutes]) {
  const target = findPlayer(ctx, q);
  if (!target) throw new Error(`no player "${q}"`);
  if (target.account) ctx.accounts.ban(target.account.id, Number(minutes) || 0, `banned by ${ctx.player.name}`);
  target.ws.close(4003, "banned");
}

function unban(ctx, [email]) {
  const acc = ctx.accounts.findByEmail(email);
  if (!acc) throw new Error(`no account ${email}`);
  ctx.accounts.unban(acc.id);
  reply(ctx, `Unbanned ${email}`);
}

function announce(ctx, args) {
  const message = args.join(" ");
  const bytes = ctx.encode("fluxBroadcast", { message, color: 0xffd34e, durationSeconds: 10 });
  for (const p of ctx.allPlayers()) if (p.ws.readyState === 1) p.ws.send(bytes);
}

function wallet(ctx, [amount, email], currency) {
  const acc = email ? ctx.accounts.findByEmail(email) : ctx.player.account;
  if (!acc) throw new Error("no account (log in, or give an email)");
  ctx.accounts.setBalance(acc.id, currency, Number(amount) || 0);
  reply(ctx, `${acc.email}: ${currency} = ${amount}`);
}

function setRole(ctx, [email, role]) {
  const acc = ctx.accounts.findByEmail(email);
  if (!acc) throw new Error(`no account ${email}`);
  ctx.accounts.update(acc.id, { role: Math.min(5, Math.max(0, Number(role) || 0)) });
  reply(ctx, `${email} is now role ${role}`);
}

// ---------- the client's built-in staff tools ----------

function runTool(ctx, msg) {
  const { player, lobby, encode, MAP } = ctx;
  const role = player.role ?? 0;
  if (role < 1) return;
  const byId = (id) => ctx.allPlayers().find((p) => p.animal?.id === id);
  switch (msg.tool) {
    case "adminUserList": {
      const list = ctx.allPlayers().filter((p) => p.animal);
      player.ws.send(encode("adminUserList", {
        ids: list.map((p) => p.animal.id),
        names: list.map((p) => p.name),
        accountIds: list.map((p) => p.account?.id ?? ""),
        ips: list.map((p) => p.ip ?? ""),
        roles: list.map((p) => p.role ?? 0),
        pings: list.map(() => 0),
        xs: list.map((p) => p.animal.x),
        ys: list.map((p) => p.animal.y),
      }));
      return;
    }
    case "adminTeleport": {
      const other = byId(msg.id);
      const me = player.animal;
      if (role < 4 || !other || !me || other.lobby !== lobby) return;
      if (msg.mode === 0) moveAnimal(me, other.animal.x, other.animal.y), (player.target = { x: me.x, y: me.y });
      else moveAnimal(other.animal, me.x, me.y), (other.target = { x: me.x, y: me.y });
      return;
    }
    case "targetPlayer": {
      const other = byId(msg.id);
      if (!other) return player.ws.send(encode("targetInfo", emptyTarget()));
      const a = other.animal;
      player.ws.send(encode("targetInfo", {
        online: true, id: a.id, accountId: other.account?.id ?? "", name: other.name, role: other.role ?? 0,
        ping: 0, x: a.x, y: a.y, size: a.size, biome: ctx.game.E[a.biomeHere] ?? "land", trailX: [], trailY: [],
      }));
      return;
    }
    case "modDisconnect": {
      const target = ctx.allPlayers().find((p) => p.account?.id === msg.accountId);
      target?.ws.close(4000, "kicked");
      return;
    }
    case "modBan": {
      if (role < 2) return;
      ctx.accounts.ban(msg.accountId, msg.durationMinutes, msg.reason);
      ctx.allPlayers().find((p) => p.account?.id === msg.accountId)?.ws.close(4003, "banned");
      return;
    }
    case "move": {
      if (role < 4) return;
      const x = (msg.x / 65535) * MAP.x, y = (msg.y / 65535) * MAP.y;
      const other = byId(msg.id);
      if (other) return moveAnimal(other.animal, x, y), (other.target = { x, y });
      const e = lobby.entities.get(msg.id);
      if (e) {
        const { id, ...rest } = e;
        lobby.removeEntity(id);
        lobby.addEntity({ ...rest, x, y });
      }
      return;
    }
    case "destroy": {
      if (role < 4) return;
      const other = byId(msg.id);
      if (other) return other.lobby.despawn(other);
      lobby.removeEntity(msg.id);
      return;
    }
  }
}

const emptyTarget = () => ({
  online: false, id: 0, accountId: "", name: "", role: 0, ping: 0, x: 0, y: 0, size: 0, biome: "", trailX: [], trailY: [],
});
