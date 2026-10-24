// Simulated playtest: one region with N bots (default 20) for MIN simulated minutes (default 15),
// no world events. Prints tick times, deaths by cause, kills, lifetimes and tiers reached.
// Usage: MIN=15 N=20 bun tools/playtest.mjs
const realNow = Date.now; let fake = realNow(); Date.now = () => fake;
const timers = []; globalThis.setTimeout = (fn, ms) => { timers.push({ at: fake + (ms ?? 0), fn }); return 0; };
const runTimers = () => { for (const t of timers.splice(0)) if (t.at <= fake) t.fn(); else timers.push(t); };
process.env.BOTS = process.env.N ?? "20";
const MIN = Number(process.env.MIN ?? 15);
const { createGameServer, DEATH } = await import(new URL("../game-server.js", import.meta.url).href);
const parties = { lobbies: () => [], get: () => null, leave() {} };
const gs = createGameServer({ accounts: null, parties });
const lobby = gs.lobbies.get("us-east");
for (const l of gs.lobbies.values()) clearInterval(l.timer);
lobby.nextEventAt = Infinity; // no events: measure the base game
lobby.serverMessage = () => {};
const stats = { deaths: {}, kills: 0, maxTier: {}, lifetimes: [], tierAtDeath: [] };
const origDespawn = lobby.despawn.bind(lobby);
lobby.despawn = (p, s, death) => {
  if (p.bot && p.animal && death) {
    const cause = Object.keys(DEATH).find((k) => DEATH[k] === death.cause) ?? death.cause;
    stats.deaths[cause] = (stats.deaths[cause] ?? 0) + 1;
    stats.lifetimes.push((fake - (p.bornAt ?? fake)) / 1000);
    stats.tierAtDeath.push(p.animal.tier);
    if (death.killer) stats.kills++;
  }
  return origDespawn(p, s, death);
};
const times = [];
for (let i = 0; i < 20 * 60 * MIN; i++) {
  for (const p of lobby.players) if (p.animal && !p.bornSeen) (p.bornAt = fake), (p.bornSeen = p.animal);
  for (const p of lobby.players) if (p.bornSeen && p.bornSeen !== p.animal && p.animal && p.animal.tier === 1) (p.bornAt = fake), (p.bornSeen = p.animal);
  const t0 = performance.now(); lobby.tick(); times.push(performance.now() - t0);
  fake += 50; runTimers();
  for (const p of lobby.players) if (p.animal) stats.maxTier[p.name] = Math.max(stats.maxTier[p.name] ?? 0, p.animal.tier);
}
times.sort((a, b) => a - b);
const pct = (q) => times[Math.floor(times.length * q)].toFixed(2);
const avg = (l) => (l.length ? (l.reduce((a, b) => a + b, 0) / l.length).toFixed(1) : "-");
console.log(`${MIN} min, ${process.env.BOTS} bots: tick p50 ${pct(0.5)} ms, p99 ${pct(0.99)} ms, max ${times.at(-1).toFixed(1)} ms`);
console.log("deaths by cause:", JSON.stringify(stats.deaths), "kills:", stats.kills, "avg life", avg(stats.lifetimes), "s, avg tier at death", avg(stats.tierAtDeath));
const tiers = Object.values(stats.maxTier); console.log("highest tier reached: max", Math.max(...tiers), "median", tiers.sort((a, b) => a - b)[Math.floor(tiers.length / 2)]);
console.log("alive now:", [...lobby.players].filter((p) => p.animal).map((p) => `${p.name}:${p.animal.slug}(t${p.animal.tier},${p.skill})`).join(" "));
process.exit(0);
