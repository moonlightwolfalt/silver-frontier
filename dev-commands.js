// Developer / staff commands for the local game server.
//
// Two entry points reach runCommand():
//   - chat lines starting with "/" (any player can use /help; the rest need a staff role)
//   - the client's built-in staff tools, unlocked in its UI for accounts with role >= MODERATOR:
//     admin user list, teleport to/bring, observe (targetPlayer), kick, ban, move/destroy.
//
// Roles (the client's own enum): USER 0, MODERATOR 1, TRUSTED_MODERATOR 2, EVENT_TEAM 3, ADMIN 4,
// DEVELOPER 5. Each command lists the lowest role allowed to run it.

import { PUMPKINS } from "./pumpkins.js";

const COMMANDS = {
  help: { role: 0, usage: "/help", run: help },
  players: { role: 1, usage: "/players", run: players },
  animal: { role: 4, usage: "/animal <name> [subspecies]", run: animal },
  tier: { role: 4, usage: "/tier <1-17>  (opens that tier's upgrade menu)", run: tier },
  xp: { role: 4, usage: "/xp <amount>  (upgrades follow, up to tier 17 at 10M)", run: xp },
  size: { role: 4, usage: "/size <size>", run: size },
  speed: { role: 4, usage: "/speed <multiplier>", run: speed },
  zoom: { role: 4, usage: "/zoom <0.2-15>", run: zoom },
  god: { role: 4, usage: "/god  (toggle)", run: god },
  tp: { role: 4, usage: "/tp <x> <y> | /tp <player>", run: tp },
  bring: { role: 4, usage: "/bring <player>", run: bring },
  spawn: { role: 4, usage: "/spawn <food> [count]", run: spawnFood },
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

function players(ctx) {
  const list = ctx.allPlayers().filter((p) => p.animal);
  reply(ctx, list.map((p) => `${p.animal.id}:${p.name || "(no name)"} [${p.lobby.region.id}] ${p.animal.slug}`).join(", ") || "nobody is playing");
}

function animal(ctx, [slug, sub]) {
  const { M } = ctx.game;
  if (!M[slug]) throw new Error(`no animal "${slug}"`);
  needAnimal(ctx);
  ctx.lobby.spawn(ctx.player, slug, Number(sub) || 0);
}

function tier(ctx, [n]) {
  needAnimal(ctx);
  ctx.lobby.showTier(ctx.player, Number(n));
}

function xp(ctx, [n]) {
  ctx.player.xp = Math.max(0, Number(n) || 0);
  ctx.lobby.sendXP(ctx.player);
  ctx.lobby.checkProgress(ctx.player);
}

function size(ctx, [n]) {
  needAnimal(ctx).size = Math.min(256, Math.max(5, Number(n) || 30));
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
