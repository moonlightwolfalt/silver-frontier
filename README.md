# silver-frontier

A private mope.io server: the real mope.io client, patched to talk only to this server, plus
its assets, a game server, accounts and a shop.

```
bun install
bun run setup    # fetch the mope.io client, prettify it, patch it for this server
bun run start    # http://localhost:3000 — everything runs on this one port
```

## Playing

- **Regions:** USA East, USA Central, USA West, Europe, Asia, Oceania and Brazil. Each is its own
  world with its own players.
- **Modes:** FFA, and **PARTY**, a private lobby. After you press Play, a chat message shows the
  invite link. Anyone who opens it lands in the same party.
- **World:** every biome gets its trees, hills, rocks, lakes, mud, puddles, holes and foods.
  The land biome has a volcano with lava pools and volcano foods, and the oceans have palm
  islands. Eaten food comes back after a few seconds.
- **Upgrades, tiers 1–17:** eating earns XP, and when it reaches the next tier (the game's own
  table, 100 XP for tier 2 up to 10M for tier 17) the upgrade menu opens with that tier's
  animals. Each tier takes about 30 foods.
- **Sandbox keys:** **Up**/**Down** step the upgrade menu through all 17 tiers, from Mouse to
  Black/King Dragon. Click an animal, or press its number key (the keys reach the first nine
  cards; click the rest). In the console, `localtest.up(n)` / `localtest.down(n)` do the same.

## Accounts

Press **Log in** and pick any provider. A sign-in page opens where you can log in or register
with email and password. Accounts, coins, gems, owned skins and equipped skins are stored in
`data/accounts.json`.

**Owner accounts** get the DEVELOPER role, 999,999,999 MopeCoins and gems, and every shop item.
List them in `data/config.json` (see `config.example.json`) or in
`OWNER_EMAILS=a@b.c,d@e.f`. `data/` is gitignored, so owner emails and passwords stay out of
the repo.

## Developer commands

Staff accounts get the client's built-in admin tools: the player list (Tab), targeting and
observing (`), teleport to/bring, kick and ban. They can also type commands in chat:

| Command | Role |
| --- | --- |
| `/help` | everyone |
| `/players`, `/kick <player>` | moderator |
| `/ban <player> [minutes]`, `/unban <email>` | trusted moderator |
| `/announce <message>` | event team |
| `/animal <name> [subspecies]`, `/tier <n>`, `/xp <n>`, `/size <n>`, `/speed <x>`, `/zoom <x>`, `/god`, `/tp <x> <y>` or `/tp <player>`, `/bring <player>`, `/spawn <food> [count]`, `/clearfood`, `/kill [player]` | admin |
| `/coins <n> [email]`, `/gems <n> [email]`, `/role <email> <0-5>` | developer |

## Files

| File | What it does |
| --- | --- |
| `fetch-mope.ts`, `pretty.ts` | Download mope.io's client into `mope-dump/` and format it |
| `patch-client.ts` | Points the client at this server: regions, account API, skins |
| `server.js` | HTTP server: client, assets, `/api` accounts, `/play` game sockets |
| `game-server.js` | Game protocol and lobbies (spawn, move, eat, upgrades, chat) |
| `world.js` | Generates each lobby's terrain and foods |
| `parties.js` | Party lobbies and invite codes |
| `accounts.js` | Account database, email login, local version of Mope's account/shop API |
| `dev-commands.js` | Chat commands and the client's staff tools |
| `regions.js` | The region list |
| `client-runtime.js` | Loads the client's own protocol code so the server encodes exactly like it |
| `asset-catalog.js` | Lists every asset from the client's tables and downloads it into `assets/<Category>/` |

Asset categories: Animals, UI, Shop Skins, Foods, Game Object Assets, Biomes, Biome Terrains.
Open `/gallery` to browse them. `POST /api/refresh` re-runs the download.

Behind an HTTP proxy, start Node with `NODE_USE_ENV_PROXY=1` so its `fetch` uses it.

The server relies on internal names in the minified client build. A new mope.io release can
rename them, and then `bun run setup` would need the server updated to match.
