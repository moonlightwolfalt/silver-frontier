# silver-frontier

A private mope.io server: the real mope.io client, patched to talk only to this server, plus
its assets, a game server, accounts and a shop.

```
bun install
bun run setup    # fetch the mope.io client, prettify it, patch it for this server
bun run start    # http://localhost:3000 — everything runs on this one port
```

## Hosting on Railway

The repo includes a `Dockerfile` and `railway.json`. The build fetches and patches the mope.io
client, and the server starts on Railway's port.

1. On [railway.com](https://railway.com): **New Project → Deploy from GitHub repo**, and pick
   this repository.
2. In the service, add a **Volume** with mount path `/data`. Accounts and downloaded assets go
   there, so they survive redeploys.
3. Under **Variables**, add:
   - `SITE_PASSWORD`: the password visitors must enter. The server won't start on Railway
     without it.
   - `OWNER_EMAILS`: your email (comma-separate several). These accounts get the developer
     role, unlimited coins and gems, and every item.
4. Under **Settings → Networking**, choose **Generate Domain**.
5. Open the domain and enter the password. Then **Log in** and register with your owner email.

Keep the service at **one replica**: each region's world lives in that server's memory. On
first start it downloads the asset catalog into `/data/assets` (about 10 minutes). The game is
playable meanwhile, because missing files are fetched from mope.io as needed.

Settings for any host: `PORT`, `SITE_PASSWORD`, `OWNER_EMAILS`, `DATA_DIR` (accounts, default
`./data`), `ASSETS_DIR` (default `./assets`). `/__health` answers without the password.

## Hosting with Cloudflare Tunnel

The server runs on your own computer (or any machine), and Cloudflare gives it a public HTTPS
address. No router ports are opened, and game connections work through the tunnel. The machine
has to stay on while people play.

### Quick test: a temporary link, no account needed

Needs [Node 22](https://nodejs.org), [Bun](https://bun.sh) and
[cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).

```
bun install
bun run setup
SITE_PASSWORD=choose-a-password OWNER_EMAILS=you@example.com node server.js
# in a second terminal:
cloudflared tunnel --url http://localhost:3000
```

On Windows PowerShell, start the server with
`$env:SITE_PASSWORD="choose-a-password"; $env:OWNER_EMAILS="you@example.com"; node server.js`.

cloudflared prints an address like `https://something.trycloudflare.com`. It changes every time
you start it, so it's only for testing.

### Permanent address on your own domain

Needs a free Cloudflare account, a domain added to Cloudflare, and
[Docker](https://docs.docker.com/get-docker/) (Docker Desktop on Windows and Mac).

1. In the Cloudflare dashboard, open **Zero Trust → Networks → Tunnels → Create a tunnel**,
   choose **Cloudflared**, and name it.
2. On the install step, pick **Docker** and copy the long token from the command it shows.
3. Under **Public Hostname**, add e.g. `mope.yourdomain.com` with service **HTTP** and URL
   **`app:3000`**.
4. In this folder, copy `.env.example` to `.env` and fill in `SITE_PASSWORD`, `OWNER_EMAILS` and
   `TUNNEL_TOKEN`.
5. Run `docker compose up -d --build`. The build fetches and patches the mope.io client.
6. Open `https://mope.yourdomain.com`, enter the password, then **Log in** and register with
   your owner email.

Accounts and assets are stored in `./data`. `docker compose logs -f app` shows the server log,
and `docker compose down` stops it.

Optional extra lock: in **Zero Trust → Access → Applications**, add the hostname as a
self-hosted application with an email policy. Cloudflare then asks for a one-time code sent to
an allowed email before the site loads (free for up to 50 users).

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
- **Size:** every animal grows from its tier's minimum to maximum size as its XP goes from
  that tier's requirement to the next tier's, using the client's own size table, including
  forms with their own range. Tier 17 grows from 10M to 20M. Losing XP shrinks it again, and
  upgrading starts the new animal at its tier's minimum. `/size <n>` pins a size and
  `/size auto` hands it back to XP.
- **Pumpkins:** 45 per world on land, arctic and desert. Touching one collects it for XP, and a
  new one appears 30 s later. Rare ones (gold and up) show on the minimap. `pumpkins.js` sets
  every variant's spawn chance and XP at tier 17. Each lower tier gets half of the tier above
  (tier 16 = ½, tier 15 = ¼, … tier 1 = 1/65,536):

  | Variant | Chance | XP at tier 17 |
  | --- | --- | --- |
  | Pumpkin | 48% | 20K |
  | Jack-o'-lantern | 25% | 50K |
  | Gold | 12% | 150K |
  | Emerald | 6% | 300K |
  | **Amber** | 3.5% | 400K |
  | **Sapphire** | 2.2% | 550K |
  | Ruby | 1.4% | 440K |
  | **Amethyst** | 0.9% | 800K |
  | Diamond | 0.5% | 1.2M |
  | **Black Hole** | 0.3% | 2M |
  | Onyx | 0.2% | 2.5M |

  The bold ones are custom. `tools/make-pumpkins.py` builds their textures from ruby's 5
  rolling frames and the artwork in `custom-assets/source/`.
- **Sandbox buttons and keys:** the on-screen **▲ Upgrade** / **▼ Downgrade** buttons (right
  side, shown while playing on a local server) and the **Up**/**Down** keys step the upgrade menu through all 17 tiers, from Mouse to
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
| `/shoot [variant] [count]` fires pumpkins the way you face (they roll, stop and can be collected; animals they hit get knocked back), `/pumpkin <variant> [count]`, `/animal <name> [subspecies]`, `/tier <n>`, `/xp <n>`, `/size <n>`, `/speed <x>`, `/zoom <x>`, `/god`, `/tp <x> <y>` or `/tp <player>`, `/bring <player>`, `/spawn <food> [count]`, `/clearfood`, `/kill [player]` | admin |
| `/coins <n> [email]`, `/gems <n> [email]`, `/role <email> <0-5>` | developer |

## Files

| File | What it does |
| --- | --- |
| `fetch-mope.ts`, `pretty.ts` | Download mope.io's client into `mope-dump/` and format it |
| `patch-client.ts` | Points the client at this server: regions, account API, skins |
| `server.js` | HTTP server: client, assets, `/api` accounts, `/play` game sockets |
| `game-server.js` | Game protocol and lobbies (spawn, move, eat, upgrades, chat) |
| `world.js` | Generates each lobby's terrain and foods |
| `pumpkins.js`, `tools/make-pumpkins.py`, `custom-assets/` | Pumpkin variants, their chances and XP, and the custom textures |
| `parties.js` | Party lobbies and invite codes |
| `accounts.js` | Account database, email login, local version of Mope's account/shop API |
| `dev-commands.js` | Chat commands and the client's staff tools |
| `regions.js` | The region list |
| `site-gate.js` | Site-wide password for hosted copies (`SITE_PASSWORD`) |
| `Dockerfile`, `railway.json` | Railway / Docker deployment |
| `docker-compose.yml`, `.env.example` | Your own machine + Cloudflare Tunnel |
| `client-runtime.js` | Loads the client's own protocol code so the server encodes exactly like it |
| `asset-catalog.js` | Lists every asset from the client's tables and downloads it into `assets/<Category>/` |

Asset categories: Animals, UI, Shop Skins, Foods, Game Object Assets, Biomes, Biome Terrains,
Abilities. Abilities holds every ability texture and animation frame: the base ones from
mope.io and every ability skin on S3, for example all 24 fireball skins with their 10 frames.
Open `/gallery` to browse them. `POST /api/refresh` re-runs the download.

Behind an HTTP proxy, start Node with `NODE_USE_ENV_PROXY=1` so its `fetch` uses it.

The server relies on internal names in the minified client build. A new mope.io release can
rename them, and then `bun run setup` would need the server updated to match.
