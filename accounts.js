// Account system for the private server: a JSON-file account database, email/password login and
// registration, and a local stand-in for Mope's account API (api.mope.io, which the client
// calls "Axis"). patch-client.ts points the client's axisURL at /api on this server.
//
// Login reuses the client's own sign-in flow: whichever provider button is pressed, the client
// asks GET /auth/<provider> where to send its popup, and we answer with our own login page. That
// page signs in or registers, sets the session cookie and posts `axis-auth-success` back, exactly
// like Mope's OAuth callback does.
//
// Owner accounts (data/config.json "owners", or OWNER_EMAILS=a@b.c,d@e.f) get the DEVELOPER role,
// effectively unlimited MopeCoins and gems, and every shop item.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileStore } from "./store.js";

const COOKIE = "mope_session";
const UNLIMITED = 999_999_999;
const SESSION_DAYS = 30;
const ROLE = { USER: 0, MODERATOR: 1, TRUSTED_MODERATOR: 2, EVENT_TEAM: 3, ADMIN: 4, DEVELOPER: 5 };
const RARITIES = ["common", "uncommon", "rare", "epic", "legendary", "mythic"];

export function createAccounts({ dataDir, store = fileStore(dataDir), itemIds = [], animalSlugs = [], records = null }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const configFile = path.join(dataDir, "config.json");
  const db = store.get("accounts") ?? { accounts: {}, sessions: {} };
  let config = { owners: [] };
  try { config = { ...config, ...JSON.parse(fs.readFileSync(configFile, "utf8")) }; } catch {}
  const owners = new Set(
    [...config.owners, ...(process.env.OWNER_EMAILS ?? "").split(",")].map((e) => e.trim().toLowerCase()).filter(Boolean),
  );

  const save = () => store.set("accounts", db, 100);

  // ---------- items (shop skins) ----------

  const slugs = [...animalSlugs].sort((a, b) => b.length - a.length);
  const forAnimal = (id) => slugs.find((s) => id === s || id.startsWith(s + "_")) ?? null;
  // Mope's real prices and rarities live on its API; we derive stable ones from the item id.
  const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 17);
  const ITEMS = itemIds
    .map((id) => {
      const animal = forAnimal(id);
      if (!animal) return null;
      const rarity = RARITIES[hash(id) % RARITIES.length];
      const gems = hash(id + "$") % 3 === 0;
      const price = gems ? 50 + 50 * RARITIES.indexOf(rarity) : 500 + 750 * RARITIES.indexOf(rarity);
      return { id, animal, rarity, currency: gems ? "GEMS" : "MOPECOINS", price };
    })
    .filter(Boolean);
  const itemById = new Map(ITEMS.map((i) => [i.id, i]));

  // ---------- accounts ----------

  const normEmail = (e) => String(e ?? "").trim().toLowerCase();
  const hashPassword = (password, salt = crypto.randomBytes(16).toString("hex")) =>
    `${salt}:${crypto.scryptSync(password, salt, 64).toString("hex")}`;
  const checkPassword = (password, stored) => {
    const [salt, hex] = stored.split(":");
    const got = crypto.scryptSync(password, salt, 64);
    return crypto.timingSafeEqual(got, Buffer.from(hex, "hex"));
  };

  const isOwner = (acc) => owners.has(acc.email);
  // Owners are re-granted on every load, so adding an email to the owner list takes effect at once.
  const effective = (acc) => {
    if (!acc) return null;
    if (isOwner(acc)) {
      acc.role = ROLE.DEVELOPER;
      acc.wallet = { MOPECOINS: UNLIMITED, GEMS: UNLIMITED };
      acc.owned = ITEMS.map((i) => i.id);
    }
    return acc;
  };

  function register(email, password, displayName) {
    email = normEmail(email);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError(400, "Enter a valid email address.");
    if (String(password ?? "").length < 6) throw httpError(400, "Password must be at least 6 characters.");
    if (findByEmail(email)) throw httpError(409, "An account with that email already exists.");
    const id = crypto.randomUUID();
    const name = String(displayName || email.split("@")[0]).slice(0, 20);
    db.accounts[id] = {
      id, email, displayName: name, handle: `${name.toLowerCase().replace(/[^a-z0-9_]/g, "")}${Math.floor(Math.random() * 9000 + 1000)}`,
      passwordHash: hashPassword(password), role: ROLE.USER, createdAt: new Date().toISOString(),
      wallet: { MOPECOINS: 500, GEMS: 0 }, owned: [], loadout: {}, nameColor: null, bannedUntil: null, banReason: null,
    };
    save();
    return effective(db.accounts[id]);
  }

  function login(email, password) {
    const acc = findByEmail(email);
    if (!acc || !checkPassword(String(password ?? ""), acc.passwordHash)) throw httpError(401, "Wrong email or password.");
    return effective(acc);
  }

  function findByEmail(email) {
    email = normEmail(email);
    return effective(Object.values(db.accounts).find((a) => a.email === email));
  }

  const get = (id) => effective(db.accounts[id]);

  function update(id, fields) {
    Object.assign(db.accounts[id], fields);
    save();
    return get(id);
  }

  function isBanned(acc) {
    if (!acc?.bannedUntil) return false;
    return acc.bannedUntil === "permanent" || new Date(acc.bannedUntil) > new Date();
  }

  function ban(id, minutes, reason) {
    if (!db.accounts[id] || isOwner(db.accounts[id])) return;
    update(id, { bannedUntil: minutes > 0 ? new Date(Date.now() + minutes * 60_000).toISOString() : "permanent", banReason: reason ?? "" });
  }

  const unban = (id) => update(id, { bannedUntil: null, banReason: null });

  function setBalance(id, currency, amount) {
    const code = currency === "gems" ? "GEMS" : "MOPECOINS";
    update(id, { wallet: { ...db.accounts[id].wallet, [code]: Math.max(0, amount) } });
  }

  // ---------- sessions ----------

  function createSession(accountId) {
    const token = crypto.randomBytes(32).toString("hex");
    db.sessions[token] = { accountId, expires: Date.now() + SESSION_DAYS * 864e5 };
    save();
    return token;
  }

  const cookies = (req) =>
    Object.fromEntries((req.headers.cookie ?? "").split(";").map((c) => c.trim().split("=")).filter((p) => p.length === 2));

  function fromRequest(req) {
    const token = cookies(req)[COOKIE];
    const s = token && db.sessions[token];
    if (!s || s.expires < Date.now()) return null;
    return get(s.accountId);
  }

  const sessionCookie = (token, maxAge = SESSION_DAYS * 86400) =>
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;

  // ---------- API responses in the shapes the client reads ----------

  const profile = (acc) => ({
    id: acc.id,
    email: acc.email,
    displayName: acc.displayName,
    role: acc.role,
    createdAt: acc.createdAt,
    avatar: { url: null, confirmed: true }, // confirmed: no first-login avatar prompt
    publicProfile: { handle: acc.handle, bio: "", displayName: acc.displayName },
    featureFlags: { canChangeNameColor: acc.role >= ROLE.MODERATOR },
    featureData: { nameColor: acc.nameColor },
    bannedUntil: isBanned(acc) ? acc.bannedUntil : null,
    huntPins: [],
    stats: {},
    totalSpawns: 0,
  });

  const wallets = (acc) => [
    { currencyCode: "MOPECOINS", amount: acc.wallet.MOPECOINS ?? 0 },
    { currencyCode: "GEMS", amount: acc.wallet.GEMS ?? 0 },
  ];

  const catalogItem = (i) => ({
    id: i.id, type: "SKIN", rarity: i.rarity.toUpperCase(), displayName: i.id,
    metadata: { forAnimal: i.animal },
  });

  const product = (acc, i) => ({
    id: `p_${i.id}`, kind: "SIMPLE", name: i.id, displayName: i.id,
    itemId: i.id, itemType: "SKIN", forAnimal: i.animal, itemRarity: i.rarity,
    price: i.price, basePrice: i.price, discountPercent: 0, currency: i.currency, tags: [],
    ownership: { owned: !!acc?.owned.includes(i.id), pricing: null },
  });

  function storefront(acc) {
    const shelves = [];
    const featured = ITEMS.filter((i) => ["legendary", "mythic"].includes(i.rarity)).slice(0, 12);
    shelves.push({ key: "featured", title: "Featured", sortOrder: 0, layout: "CAROUSEL", kind: "CURATED", products: featured.map((i) => product(acc, i)) });
    RARITIES.slice().reverse().forEach((r, n) =>
      shelves.push({ key: `rarity_${r}`, title: r[0].toUpperCase() + r.slice(1), sortOrder: n + 1, layout: "GRID", kind: "STANDARD",
        products: ITEMS.filter((i) => i.rarity === r).map((i) => product(acc, i)) }),
    );
    return { shelves, catalog: ITEMS.map((i) => product(acc, i)) };
  }

  const loadout = (acc) => ({
    slots: Object.entries(acc.loadout ?? {}).map(([animal, itemId]) => ({
      slotType: "SKIN", slotKey: `animal_${animal}`, equippedItemId: itemId,
    })),
  });

  // ---------- HTTP ----------

  const json = (res, code, body, headers = {}) => {
    res.writeHead(code, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) =>
    new Promise((resolve) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try { resolve(JSON.parse(raw || "{}")); } catch { resolve({}); }
      });
    });

  async function handleApi(req, res, route, origin) {
    const method = req.method;
    const acc = fromRequest(req);
    const needAuth = () => {
      if (!acc) throw httpError(401, "Not signed in");
      if (isBanned(acc)) throw Object.assign(httpError(403, "Banned"), { code: "ACCOUNT_BANNED", details: { reason: acc.banReason, expiresAt: acc.bannedUntil === "permanent" ? null : acc.bannedUntil, permanent: acc.bannedUntil === "permanent" } });
      return acc;
    };
    try {
      // Sign-in: every provider goes through our email/password page.
      let m;
      if (method === "GET" && (m = route.match(/^\/auth\/(google|discord|facebook|apple)$/)))
        return json(res, 200, {
          clientId: "local", redirectUri: `${origin}/api/auth/callback`, scope: "email", responseType: "code",
          state: crypto.randomBytes(8).toString("hex"), authorizationEndpoint: `${origin}/api/auth/login-page`,
        });
      if (method === "GET" && route.startsWith("/auth/login-page")) {
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end(LOGIN_PAGE);
      }
      if (method === "POST" && (route === "/auth/email/login" || route === "/auth/email/register")) {
        const body = await readBody(req);
        const a = route.endsWith("register") ? register(body.email, body.password, body.displayName) : login(body.email, body.password);
        if (isBanned(a)) throw httpError(403, "This account is banned.");
        return json(res, 200, { ok: true, profile: profile(a) }, { "Set-Cookie": sessionCookie(createSession(a.id)) });
      }
      if (method === "POST" && (route === "/auth/logout" || route === "/auth/logout/all")) {
        const token = cookies(req)[COOKIE];
        if (route.endsWith("/all") && acc) for (const [t, s] of Object.entries(db.sessions)) s.accountId === acc.id && delete db.sessions[t];
        else delete db.sessions[token];
        save();
        return json(res, 200, { ok: true }, { "Set-Cookie": sessionCookie("", 0) });
      }

      // Account
      if (route === "/users/me" && method === "GET") return json(res, 200, profile(needAuth()));
      if (route === "/users/me" && method === "PATCH") {
        const body = await readBody(req);
        const a = needAuth();
        const fields = {};
        if (typeof body.displayName === "string") fields.displayName = body.displayName.slice(0, 20);
        if (typeof body.handle === "string") fields.handle = body.handle.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 20);
        return json(res, 200, profile(update(a.id, fields)));
      }
      if (route === "/users/name-color" && method === "POST") {
        const body = await readBody(req);
        return json(res, 200, profile(update(needAuth().id, { nameColor: body.nameColor ?? null })));
      }
      if ((m = route.match(/^\/users\/(?:handle\/)?([^/]+)$/)) && method === "GET") {
        const other = Object.values(db.accounts).find((a) => a.id === m[1] || a.handle === m[1]);
        return other ? json(res, 200, profile(effective(other))) : json(res, 404, { message: "Not found" });
      }
      if (route === "/wallets") return json(res, 200, wallets(needAuth()));

      // Inventory, catalog and loadout
      if (route.startsWith("/inventory/catalog")) return json(res, 200, { items: ITEMS.map(catalogItem) });
      if (route.startsWith("/inventory")) {
        const a = needAuth();
        const q = new URL(route, "http://x").searchParams;
        let items = a.owned.map((id) => itemById.get(id)).filter(Boolean);
        if (q.get("search")) items = items.filter((i) => i.id.includes(q.get("search")));
        const limit = Number(q.get("limit") || 100), page = Number(q.get("page") || 1);
        return json(res, 200, {
          items: items.slice((page - 1) * limit, page * limit).map((i) => ({ itemId: i.id, quantity: 1, item: catalogItem(i) })),
          totalPages: Math.max(1, Math.ceil(items.length / limit)), page, total: items.length,
        });
      }
      if (route === "/loadout") return json(res, 200, loadout(needAuth()));
      if (route === "/loadout/slots") return json(res, 200, { slots: animalSlugs.map((s) => ({ slotType: "SKIN", slotKey: `animal_${s}` })) });
      if (route === "/loadout/equip" && method === "POST") {
        const a = needAuth();
        const { itemId, slotKey } = await readBody(req);
        const item = itemById.get(itemId);
        if (!item || !a.owned.includes(itemId)) throw httpError(400, "You don't own that item.");
        const animal = String(slotKey ?? "").replace(/^animal_/, "") || item.animal;
        update(a.id, { loadout: { ...a.loadout, [animal]: itemId } });
        return json(res, 200, { ok: true });
      }
      if (route === "/loadout/unequip" && method === "POST") {
        const a = needAuth();
        const { slotKey } = await readBody(req);
        const lo = { ...a.loadout };
        delete lo[String(slotKey ?? "").replace(/^animal_/, "")];
        update(a.id, { loadout: lo });
        return json(res, 200, { ok: true });
      }
      if (route === "/loadout/skins/unequip-all" && method === "POST") {
        update(needAuth().id, { loadout: {} });
        return json(res, 200, { ok: true });
      }

      // Shop
      if (route === "/store" && method === "GET") return json(res, 200, storefront(acc));
      if (route === "/store/purchase" && method === "POST") {
        const a = needAuth();
        const { productId } = await readBody(req);
        const item = itemById.get(String(productId ?? "").replace(/^p_/, ""));
        if (!item) throw httpError(404, "No such product.");
        if (a.owned.includes(item.id)) return json(res, 200, { ok: true });
        const balance = a.wallet[item.currency] ?? 0;
        if (balance < item.price) throw httpError(400, "Not enough balance.");
        update(a.id, { owned: [...a.owned, item.id], wallet: { ...a.wallet, [item.currency]: balance - item.price } });
        return json(res, 200, { ok: true });
      }
      if (route === "/currency-bundles") return json(res, 200, []);
      if (route.startsWith("/currency-bundles/history")) return json(res, 200, { items: [], total: 0 });
      if (route === "/store/subscriptions") return json(res, 200, { passes: [] });
      if (route === "/store/subscriptions/me") return json(res, 200, { subscriptions: [] });
      if (route === "/store/subscriptions/me/drops") return json(res, 200, { drops: [] });

      // Social and progression features we don't run: answer with empty data so the UI stays calm.
      if (route === "/friends" || route.startsWith("/friends?")) return json(res, 200, { friends: [], items: [], total: 0 });
      if (route === "/friends/pending") return json(res, 200, { received: [], sent: [] });
      if (route.startsWith("/notifications")) return json(res, 200, method === "GET" ? [] : { ok: true });
      if (route === "/passes/running") return json(res, 200, []);
      if (route === "/quests/active") return json(res, 200, []);
      // Worldwide boards (records.js): most XP and pumpkin goals, for the menu Leaderboard.
      if (records && route.startsWith("/stats/catalogue")) return json(res, 200, records.catalogue());
      if (records && (m = route.match(/^\/stats\/board\/([\w-]+)(\/me)?(?:\?|$)/))) {
        const q = new URL(route, "http://x").searchParams;
        if (m[2]) return json(res, 200, acc ? records.mine(m[1], q.get("period"), acc.id) : { rank: null, estimated: false, total: 0, entries: [] });
        const board = records.board(m[1], q.get("period"), Math.min(100, Number(q.get("limit")) || 50));
        return board ? json(res, 200, board) : json(res, 404, { message: "No such board" });
      }
      if (route.startsWith("/stats/bestiary/global")) return json(res, 200, { variants: [] });
      if (route.startsWith("/stats/bestiary")) return json(res, 200, { animals: [], huntPins: [] });
      if (route.startsWith("/stats/achievements")) return json(res, 200, { achievements: [] });
      if (route.startsWith("/stats/")) return json(res, 200, {});
      if (route.startsWith("/region/")) return json(res, 200, { country: "US", best: null });
      if (route.startsWith("/leaderboard/")) return json(res, 200, { entries: [], total: 0 });
      if (route.startsWith("/chains")) return json(res, 200, { items: [], total: 0 });
      if (route.startsWith("/session/list")) return json(res, 200, []);
      if (route.startsWith("/recap/")) return json(res, 200, { available: false });
      if (route.startsWith("/users/me/avatar/options")) return json(res, 200, { presets: [], options: [] });
      if (route === "/users/me/avatar" && method === "DELETE") return json(res, 200, { url: null, confirmed: true });
      if (route.startsWith("/telemetry")) return json(res, 200, { ok: true });
      return json(res, 404, { message: `No local handler for ${method} ${route}` });
    } catch (e) {
      return json(res, e.status ?? 500, { message: e.message, error: e.message, code: e.code, details: e.details });
    }
  }

  return {
    handleApi, fromRequest, findByEmail, get, update, ban, unban, isBanned, setBalance, ROLE,
    equippedSkin: (acc, animal) => (acc?.loadout ?? {})[animal] ?? "",
  };
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

// The sign-in popup. Posts `axis-auth-success` to the game window like Mope's OAuth callback.
const LOGIN_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in</title><style>
:root{color-scheme:light dark;--bg:#1d6b2a;--card:#fff;--ink:#163;--accent:#2fbf46}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);font:15px system-ui,sans-serif}
form{background:var(--card);color:#123;padding:24px;border-radius:14px;width:min(340px,calc(100vw - 32px));box-shadow:0 8px 30px #0004}
h1{margin:0 0 4px;font-size:22px}p{margin:0 0 16px;color:#567}
.tabs{display:flex;gap:6px;margin-bottom:14px}.tabs button{flex:1;padding:8px;border:0;border-radius:8px;background:#e8efe9;cursor:pointer;font-weight:600}
.tabs button[aria-pressed=true]{background:var(--accent);color:#fff}
label{display:block;font-size:13px;margin:10px 0 4px;color:#345}input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #bcd;border-radius:8px;font-size:15px}
button.submit{margin-top:16px;width:100%;padding:11px;border:0;border-radius:8px;background:var(--accent);color:#fff;font-weight:700;font-size:16px;cursor:pointer}
.err{color:#c22;min-height:1.2em;margin-top:10px;font-size:13px}.name{display:none}form.register .name{display:block}
</style></head><body><form id="f"><h1>mope.io (private)</h1><p>Sign in with your email.</p>
<div class="tabs"><button type="button" id="tl" aria-pressed="true">Log in</button><button type="button" id="tr" aria-pressed="false">Register</button></div>
<label class="name">Display name<input id="n" autocomplete="nickname" maxlength="20"></label>
<label>Email<input id="e" type="email" autocomplete="email" required></label>
<label>Password<input id="p" type="password" autocomplete="current-password" minlength="6" required></label>
<button class="submit" id="s">Log in</button><div class="err" id="err"></div></form>
<script>
let mode="login";const f=document.getElementById("f");
const set=(m)=>{mode=m;f.className=m;tl.setAttribute("aria-pressed",m==="login");tr.setAttribute("aria-pressed",m==="register");s.textContent=m==="login"?"Log in":"Create account";p.autocomplete=m==="login"?"current-password":"new-password"};
tl.onclick=()=>set("login");tr.onclick=()=>set("register");
f.onsubmit=async(ev)=>{ev.preventDefault();err.textContent="";s.disabled=true;
 try{const r=await fetch("/api/auth/email/"+mode,{method:"POST",headers:{"Content-Type":"application/json"},credentials:"include",body:JSON.stringify({email:e.value,password:p.value,displayName:n.value})});
  const d=await r.json();if(!r.ok)throw new Error(d.message||"Sign-in failed");
  if(window.opener){window.addEventListener("message",(m)=>{if(m.data&&m.data.type==="axis-auth-response")window.close()});
   window.opener.postMessage({type:"axis-auth-success"},location.origin);setTimeout(()=>window.close(),1500)}
  else location.href="/";
 }catch(x){err.textContent=x.message}finally{s.disabled=false}};
</script></body></html>`;
