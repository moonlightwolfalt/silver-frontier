// Worldwide records across every region and party: the most XP anyone has reached and the most
// pumpkin goals scored. Kept per week, per month and all time in data/records.json, and served to
// the client's menu Leaderboard through the stats board API (accounts.js).
//
// Players are identified by their account when signed in, otherwise by the name they played as.
import fs from "node:fs";
import path from "node:path";

export const STATS = [
  { key: "most_xp", label: "Most XP", unit: "xp", board: true },
  { key: "pumpkin_goals", label: "Pumpkin goals", unit: "count", board: true },
];

// ISO week, e.g. "2026-W43"
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const week = Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 864e5 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

const bucketKeys = (d = new Date()) => ({
  alltime: "alltime",
  monthly: `m:${d.toISOString().slice(0, 7)}`,
  weekly: `w:${isoWeek(d)}`,
});
const normPeriod = (p) => (p === "all-time" || p === "alltime" || !p ? "alltime" : p);

export function createRecords({ dataDir }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "records.json");
  let db = { people: {}, boards: {} }; // boards[stat][bucket][personId] = value
  try { db = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}

  let timer = null;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      fs.writeFileSync(file + ".tmp", JSON.stringify(db));
      fs.renameSync(file + ".tmp", file);
    }, 2000);
  };

  const person = (p) => {
    const id = p.account ? `acc:${p.account.id}` : `guest:${(p.name || "unnamed").toLowerCase()}`;
    db.people[id] = {
      name: p.account?.displayName ?? (p.name || "Unnamed"),
      handle: p.account?.handle ?? null,
      accountId: p.account?.id ?? null,
    };
    return id;
  };

  const bucket = (stat, key) => ((db.boards[stat] ??= {})[key] ??= {});

  function recordXP(p) {
    const id = person(p);
    let changed = false;
    for (const key of Object.values(bucketKeys())) {
      const b = bucket("most_xp", key);
      if ((b[id] ?? 0) < p.xp) (b[id] = p.xp), (changed = true);
    }
    if (changed) save();
  }

  function addGoal(p) {
    const id = person(p);
    for (const key of Object.values(bucketKeys())) {
      const b = bucket("pumpkin_goals", key);
      b[id] = (b[id] ?? 0) + 1;
    }
    save();
    return db.boards.pumpkin_goals.alltime[id];
  }

  const ranked = (stat, period) => {
    const key = bucketKeys()[normPeriod(period)] ?? "alltime";
    return Object.entries(db.boards[stat]?.[key] ?? {})
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([id, value], i) => ({ id, value, rank: i + 1 }));
  };

  // Entries in the shape the client's leaderboard reads.
  const entry = ({ id, value, rank }) => {
    const who = db.people[id] ?? { name: "Unknown" };
    return {
      rank, value, userId: id,
      user: { id: who.accountId ?? id, isAnonymous: !who.accountId, displayName: who.name, handle: who.handle ?? undefined, avatarUrl: null },
    };
  };

  return {
    recordXP,
    addGoal,
    catalogue: () => STATS,
    board(stat, period, limit = 50) {
      const info = STATS.find((s) => s.key === stat);
      if (!info) return null;
      const all = ranked(stat, period);
      return { key: stat, label: info.label, unit: info.unit, period: normPeriod(period), total: all.length, entries: all.slice(0, limit).map(entry) };
    },
    mine(stat, period, accountId, around = 4) {
      const all = ranked(stat, period);
      const i = all.findIndex((e) => e.id === `acc:${accountId}`);
      if (i < 0) return { rank: null, estimated: false, total: all.length, entries: [] };
      return { rank: i + 1, estimated: false, total: all.length, entries: all.slice(Math.max(0, i - around), i + around + 1).map(entry) };
    },
    top(stat) {
      const best = ranked(stat, "alltime")[0];
      return best ? { name: db.people[best.id]?.name ?? "Unknown", value: best.value } : null;
    },
  };
}
