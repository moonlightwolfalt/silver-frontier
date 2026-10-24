// Achievements and quests for signed-in players (the client's Awards and Quests tabs).
//
// Achievements: the client's own list (X_: First Bite, Forager, Rare Find, Arena Debut, …, with
// their filters such as "as tier 14 or lower, kill a tier 15+"), plus this server's own
// (CUSTOM_ACHIEVEMENTS, added to the client by patch-client.ts). The game reports what happens
// (kills, foods, rares, goals, tiers, wins, …) and progress is kept per account. Unlocking one
// shows the client's toast and pays its reward.
//
// Quests: three daily and three weekly quests per account, picked from QUEST_POOL, paying coins.
// Finishing all of a day's dailies keeps a streak going, with more coins each day.

// Achievements this server adds: [id, tier, metric, goal, scope, filter, reward, name, description].
export const CUSTOM_ACHIEVEMENTS = [
  ["spelunker", "bronze", "layer_visited", 1, "lifetime", { layer: "underground" }, { coins: 50 }, "Spelunker", "Go underground through a tunnel."],
  ["head_in_the_clouds", "silver", "layer_visited", 1, "lifetime", { layer: "sky" }, { coins: 100 }, "Head in the Clouds", "Reach the sky."],
  ["starborn", "gold", "layer_visited", 1, "lifetime", { layer: "space" }, { gems: 10 }, "Starborn", "Fly off the top of the sky into space."],
  ["boss_slayer", "gold", "boss_eaten", 1, "lifetime", {}, { gems: 15 }, "Boss Slayer", "Eat a boss."],
  ["last_one_standing", "silver", "br_wins", 1, "lifetime", {}, { coins: 200 }, "Last One Standing", "Win a Battle Royale."],
  ["champion", "gold", "tournament_wins", 1, "lifetime", {}, { gems: 20 }, "Champion", "Win a tournament."],
  ["ranked_gold", "silver", "ranked_rating", 1250, "lifetime", {}, { coins: 150 }, "Gold Rank", "Reach a ranked 1v1 rating of 1250."],
  ["ranked_champion", "platinum", "ranked_rating", 1700, "lifetime", {}, { gems: 50 }, "Champion Rank", "Reach a ranked 1v1 rating of 1700."],
  ["cake_king", "bronze", "cake_king", 1, "lifetime", {}, { coins: 50 }, "Cake King", "Be king of the giant cake."],
  ["new_horizons", "silver", "custom_animal_played", 10, "lifetime", {}, { coins: 150 }, "New Horizons", "Play as {goal} animals from the swamp, underground, sky or space."],
].map(([id, tier, metric, goal, scope, filter, reward, name, description]) => ({ id, tier, metric, goal, scope, filter, reward, name, description }));

// Quests: [key, label (and its wording for a goal of 1), metric, goals for daily and weekly,
// coins for daily and weekly].
const QUEST_POOL = [
  ["eat", ["Eat {goal} foods"], "food_eaten", [150, 1200], [30, 150]],
  ["hunt", ["Eat {goal} players"], "players_eaten", [3, 20], [40, 200]],
  ["tier", ["Reach tier {goal}"], "tier_reached", [8, 13], [30, 150]],
  ["goal", ["Score {goal} pumpkin goals", "Score a pumpkin goal"], "event_objective", [1, 6], [40, 200]],
  ["rare", ["Roll {goal} rare animals", "Roll a rare animal"], "rare_spawned", [1, 5], [50, 250]],
  ["arena", ["Win {goal} 1v1s", "Win a 1v1"], "arena_wins", [1, 8], [40, 200]],
  ["survive", ["Stay alive {goal} minutes in one life"], "minutes_alive", [10, 30], [30, 150]],
  ["explore", ["Go underground, to the sky or to space {goal} times", "Go underground, to the sky or to space"], "layer_visited", [1, 6], [30, 150]],
  ["coins", ["Earn {goal} coins in game"], "coins_earned", [100, 800], [30, 150]],
];
const labelFor = ([many, one], goal) => (goal === 1 && one ? one : many.replace("{goal}", goal));
const STREAK_COINS = (day) => Math.min(250, 25 * day);

const today = (d = new Date()) => d.toISOString().slice(0, 10);
const isoWeek = (d = new Date()) => {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  return `${t.getUTCFullYear()}-W${Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 864e5 + 1) / 7)}`;
};
// A stable pick of n items from list for a seed (same quests all day for one account).
function seeded(list, n, seed) {
  let h = [...seed].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const rest = [...list], out = [];
  while (out.length < n && rest.length) {
    h = (h * 1664525 + 1013904223) >>> 0;
    out.push(rest.splice(h % rest.length, 1)[0]);
  }
  return out;
}

export function createProgress({ store, accounts, clientAchievements = [], customSlugs = new Set(), apexes = [], monsters = [] }) {
  const db = store.get("progress") ?? { players: {} };
  const save = () => store.set("progress", db, 2000);
  const defs = [...clientAchievements, ...CUSTOM_ACHIEVEMENTS];
  const of = (accountId) => (db.players[accountId] ??= { counts: {}, sets: {}, unlocked: {}, quests: null, streak: { days: 0, best: 0, last: null } });

  // ---------- achievements ----------

  function unlock(p, me, def) {
    if (me.unlocked[def.id]) return;
    me.unlocked[def.id] = new Date().toISOString();
    const r = def.reward ?? {};
    const acc = accounts.get(p.account.id);
    if (acc && (r.coins || r.gems)) {
      if (r.coins) accounts.setBalance(acc.id, "coins", (acc.wallet?.MOPECOINS ?? 0) + r.coins);
      if (r.gems) accounts.setBalance(acc.id, "gems", (accounts.get(acc.id).wallet?.GEMS ?? 0) + r.gems);
    }
    p.lobby?.toast?.(p, def);
  }

  // Lifetime value of a metric for an achievement (distinct sets for the "every …" ones).
  const SETS = { culinary_arts: "foods", seven_wonders: "apexes", five_disasters: "monsters", worth_it_all: "pumpkins", a_real_monster: "rareKills", new_horizons: "customAnimals" };
  function valueOf(me, def) {
    if (SETS[def.id]) return (me.sets[SETS[def.id]] ?? []).length;
    return me.counts[`${def.id}`] ?? 0;
  }

  // Something happened to p: metric with details for the filters; amount adds (or `value` sets).
  function report(p, metric, detail = {}, amount = 1) {
    if (!p?.account || p.bot) return;
    const me = of(p.account.id);
    for (const def of defs) {
      if (def.metric !== metric || me.unlocked[def.id] || !matches(def, detail)) continue;
      if (def.scope === "life" || metric === "tier_reached" || metric === "ranked_rating") {
        if ((detail.value ?? 0) >= def.goal) unlock(p, me, def);
        else me.counts[def.id] = Math.max(me.counts[def.id] ?? 0, detail.value ?? 0);
        continue;
      }
      if (!SETS[def.id]) me.counts[def.id] = (me.counts[def.id] ?? 0) + amount;
      if (valueOf(me, def) >= def.goal) unlock(p, me, def);
    }
    questReport(p, me, metric, detail, amount);
    save();
  }

  // Distinct things (foods eaten, apexes played, …) for the "every …" achievements.
  function remember(p, set, item) {
    if (!p?.account || p.bot) return;
    const me = of(p.account.id);
    const list = (me.sets[set] ??= []);
    if (!list.includes(item)) list.push(item);
  }

  function matches(def, d) {
    const f = def.filter ?? {};
    if (f.objective && f.objective !== d.objective) return false;
    if (f.subspecies && !f.subspecies.includes(d.subspecies)) return false;
    if (f.layer && f.layer !== d.layer) return false;
    if (f.animals && !f.animals.includes(d.animal)) return false;
    if (f.opponentAnimals && !f.opponentAnimals.includes(d.opponent)) return false;
    if (f.minOpponentTier && !(d.opponentTier >= f.minOpponentTier)) return false;
    if (f.maxTier && !(d.tier <= f.maxTier)) return false;
    if (f.biome && f.biome !== d.biome) return false;
    if (f.causes && !f.causes.includes(d.cause)) return false;
    if (f.opponentFlying && !d.opponentFlying) return false;
    if (f.bird && !d.flying) return false;
    if (f.variants && !f.variants.includes(d.variant)) return false;
    if (f.opponentVariants && !f.opponentVariants.includes(d.opponentVariant)) return false;
    if (f.freshLife && !d.freshLife) return false;
    if (f.maxLifeSeconds && !(d.lifeSeconds <= f.maxLifeSeconds)) return false;
    if (f.unhurt && !d.unhurt) return false;
    return true;
  }

  // ---------- quests ----------

  function questsOf(accountId) {
    const me = of(accountId);
    const day = today(), week = isoWeek();
    const q = (me.quests ??= {});
    if (q.day !== day) {
      q.day = day;
      q.daily = seeded(QUEST_POOL, 3, accountId + day).map(([key, label, metric, goals, coins]) =>
        ({ id: `d:${day}:${key}`, key, label: labelFor(label, goals[0]), metric, goal: goals[0], progress: 0, xp: coins[0], period: "daily" }));
      q.dailyPaid = false;
    }
    if (q.week !== week) {
      q.week = week;
      q.weekly = seeded(QUEST_POOL, 3, accountId + week).map(([key, label, metric, goals, coins]) =>
        ({ id: `w:${week}:${key}`, key, label: labelFor(label, goals[1]), metric, goal: goals[1], progress: 0, xp: coins[1], period: "weekly" }));
    }
    return q;
  }

  function questReport(p, me, metric, detail, amount) {
    const q = questsOf(p.account.id);
    for (const quest of [...q.daily, ...q.weekly]) {
      if (quest.metric !== metric || quest.completed) continue;
      if (metric === "tier_reached" || metric === "minutes_alive") quest.progress = Math.max(quest.progress, detail.value ?? 0);
      else if (metric !== "event_objective" || detail.objective === "pumpkin_goal") quest.progress += amount;
      if (quest.progress < quest.goal) continue;
      quest.progress = quest.goal;
      quest.completed = true;
      pay(p, quest.xp);
      p.lobby?.serverMessage(p, `Quest done: ${quest.label}! +${quest.xp} coins`);
    }
    // all of today's dailies done: the streak goes on
    if (!q.dailyPaid && q.daily.every((x) => x.completed)) {
      q.dailyPaid = true;
      const s = me.streak;
      const yesterday = today(new Date(Date.now() - 864e5));
      s.days = s.last === yesterday ? s.days + 1 : 1;
      s.best = Math.max(s.best, s.days);
      s.last = today();
      pay(p, STREAK_COINS(s.days));
      p.lobby?.serverMessage(p, `Daily streak: day ${s.days}! +${STREAK_COINS(s.days)} coins`);
    }
  }

  function pay(p, coins) {
    const acc = accounts.get(p.account.id);
    if (acc) accounts.setBalance(acc.id, "coins", (acc.wallet?.MOPECOINS ?? 0) + coins);
  }

  // ---------- API ----------

  function activeQuests(accountId) {
    const q = questsOf(accountId);
    const s = of(accountId).streak;
    const doneToday = s.last === today();
    const alive = s.last === today() || s.last === today(new Date(Date.now() - 864e5));
    const days = alive ? s.days : 0;
    return {
      quests: [...q.daily, ...q.weekly].map(({ metric, ...x }) => ({ ...x, passId: null })), // not tied to a battle pass
      xpBoostPercent: null,
      xpBoostActive: null,
      streak: {
        days, best: s.best, todayDone: doneToday,
        next: { days: doneToday ? days + 1 : days + 1, coins: STREAK_COINS(days + 1) },
        reachedToday: doneToday ? { days, coins: STREAK_COINS(days) } : null,
      },
    };
  }

  const achievementsOf = (accountId) => {
    const me = of(accountId);
    return {
      achievements: defs.map((def) => ({ id: def.id, value: valueOf(me, def), unlockedAt: me.unlocked[def.id] ?? null })),
    };
  };

  function globals() {
    const players = Object.keys(db.players).length;
    const holders = {};
    for (const me of Object.values(db.players)) for (const id of Object.keys(me.unlocked)) holders[id] = (holders[id] ?? 0) + 1;
    return { players, unlocks: defs.map((d) => ({ id: d.id, holders: holders[d.id] ?? 0 })) };
  }

  // ---------- game events ----------

  return {
    activeQuests, achievementsOf, globals,
    kill(killer, victim, cause) {
      const a = killer.animal, b = victim.animal;
      if (!a || !b) return;
      const variant = (an) => (an.subspecies ? `${an.slug}:${String(an.subspeciesName ?? "").toLowerCase()}` : null);
      if (b.subspecies) remember(killer, "rareKills", variant(b));
      if (victim.boss) report(killer, "boss_eaten");
      report(killer, "players_eaten", {
        animal: a.slug, tier: a.tier, opponent: b.slug, opponentTier: b.tier, biome: a.biomeName, cause,
        flying: !!a.flying, opponentFlying: !!b.flying, opponentVariant: variant(b),
      });
    },
    food(p, name) {
      remember(p, "foods", name);
      report(p, "food_eaten", { food: name });
    },
    rare(p, slug, subName) {
      report(p, "rare_spawned", { variant: `${slug}:${String(subName).toLowerCase()}` });
    },
    tier(p, a, life) {
      if (apexes.includes(a.slug)) remember(p, "apexes", a.slug);
      if (monsters.includes(a.slug)) remember(p, "monsters", a.slug);
      if (customSlugs.has(a.slug)) (remember(p, "customAnimals", a.slug), report(p, "custom_animal_played"));
      report(p, "animal_played");
      if (a.slug === "king_dragon" && !life.sandbox) report(p, "king_dragon_earned");
      report(p, "tier_reached", { value: a.tier, freshLife: !life.sandbox, lifeSeconds: life.seconds, unhurt: !life.hurt });
    },
    goal(p, variantId) {
      remember(p, "pumpkins", variantId);
      report(p, "event_objective", { objective: "pumpkin_goal", subspecies: variantId });
    },
    arenaWin: (p) => report(p, "arena_wins"),
    alive(p, seconds, biomes) {
      report(p, "seconds_alive", { value: seconds });
      report(p, "minutes_alive", { value: Math.floor(seconds / 60) });
      report(p, "biomes_visited", { value: biomes });
    },
    layer: (p, layer) => report(p, "layer_visited", { layer }),
    brWin: (p) => report(p, "br_wins"),
    tournamentWin: (p) => report(p, "tournament_wins"),
    rating: (p, value) => report(p, "ranked_rating", { value }),
    cakeKing: (p) => report(p, "cake_king"),
    coins: (p, n) => report(p, "coins_earned", {}, n),
  };
}
