// Where the server keeps its data (accounts, worldwide records, the recorded map): JSON files in
// DATA_DIR, or, when DATABASE_URL is set, one Postgres table (key -> JSON), so nothing is lost
// when a host without a disk (Render free) redeploys.
//
// Everything is read once at startup and kept in memory; get() is synchronous. set() saves in
// the background, a moment after the last change. The first time a database is used, existing
// files are copied into it. Pending saves are written out before the process exits.
import fs from "node:fs";
import path from "node:path";

const TABLE = "silver_frontier";

export async function createStore({ dataDir }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const fileOf = (key) => path.join(dataDir, `${key}.json`);
  const readFile = (key) => {
    try { return JSON.parse(fs.readFileSync(fileOf(key), "utf8")); } catch { return null; }
  };
  const pending = new Map(); // key -> timer
  const writers = [];
  const flushers = new Map(); // key -> () => Promise

  let sql = null;
  const cache = new Map();
  if (process.env.DATABASE_URL) {
    const { SQL } = await import("bun");
    sql = new SQL(process.env.DATABASE_URL);
    await sql.unsafe(`create table if not exists ${TABLE} (key text primary key, value jsonb not null, updated_at timestamptz not null default now())`);
    for (const row of await sql.unsafe(`select key, value from ${TABLE}`))
      cache.set(row.key, typeof row.value === "string" ? JSON.parse(row.value) : row.value);
    console.log(`data: Postgres (${cache.size} saved ${cache.size === 1 ? "entry" : "entries"})`);
  } else console.log(`data: files in ${dataDir}`);

  const write = async (key, value) => {
    if (sql) {
      const json = JSON.stringify(value);
      await sql.unsafe(
        `insert into ${TABLE} (key, value, updated_at) values ($1, $2::jsonb, now()) on conflict (key) do update set value = excluded.value, updated_at = now()`,
        [key, json],
      );
    } else {
      fs.writeFileSync(fileOf(key) + ".tmp", JSON.stringify(value));
      fs.renameSync(fileOf(key) + ".tmp", fileOf(key));
    }
  };

  const store = {
    kind: sql ? "postgres" : "files",
    get(key) {
      if (!sql) return readFile(key);
      if (!cache.has(key)) {
        const old = readFile(key); // carry existing files over the first time
        if (old) cache.set(key, old), store.set(key, old);
      }
      return cache.get(key) ?? null;
    },
    set(key, value, delay = 1000) {
      if (sql) cache.set(key, value);
      clearTimeout(pending.get(key));
      const run = () => {
        pending.delete(key);
        flushers.delete(key);
        const p = write(key, value).catch((e) => console.error(`data: saving ${key} failed:`, e.message));
        writers.push(p);
        return p;
      };
      flushers.set(key, run);
      pending.set(key, setTimeout(run, delay));
    },
    delete(key) {
      cache.delete(key);
      clearTimeout(pending.get(key));
      pending.delete(key);
      flushers.delete(key);
      if (sql) sql.unsafe(`delete from ${TABLE} where key = $1`, [key]).catch(() => {});
      else fs.rmSync(fileOf(key), { force: true });
    },
    // Writes out everything still waiting (on shutdown).
    async flush() {
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
      await Promise.all([...[...flushers.values()].map((run) => run()), ...writers]);
    },
  };

  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => store.flush().finally(() => process.exit(0)));
  return store;
}

// A file-only store without the async setup, for code and tests given just a folder.
export function fileStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const fileOf = (key) => path.join(dataDir, `${key}.json`);
  const timers = new Map();
  return {
    kind: "files",
    get(key) {
      try { return JSON.parse(fs.readFileSync(fileOf(key), "utf8")); } catch { return null; }
    },
    set(key, value, delay = 1000) {
      clearTimeout(timers.get(key));
      timers.set(key, setTimeout(() => {
        fs.writeFileSync(fileOf(key) + ".tmp", JSON.stringify(value));
        fs.renameSync(fileOf(key) + ".tmp", fileOf(key));
      }, delay));
    },
    delete: (key) => fs.rmSync(fileOf(key), { force: true }),
    flush: async () => {},
  };
}
