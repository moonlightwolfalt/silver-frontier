# silver-frontier

A private mope.io server: the real mope.io client, patched to talk only to this server, plus
its assets, a game server, accounts and a shop.

```
bun install
bun run setup    # fetch the mope.io client, prettify it, patch it for this server
bun run start    # http://localhost:3000 — everything runs on this one port
```

## Hosting on Render (free, no card)

`render.yaml` sets up a free Render web service from the Dockerfile.

1. Open **https://render.com/deploy?repo=https://github.com/moonlightwolfalt/silver-frontier**
   and sign in with GitHub.
2. Fill in `SITE_PASSWORD` (the password visitors must enter) and `OWNER_EMAILS` (your email),
   then **Deploy Blueprint**.
3. When the deploy is **Live**, open the `https://….onrender.com` link and enter the password.

The free plan sleeps after 15 minutes without visitors, and the next visit takes about a minute
to wake it. It also has no persistent disk, so accounts reset when it restarts. Owner emails get
their perks back as soon as they register again. Assets aren't pre-downloaded there; each file
is fetched from mope.io the first time it's needed.

## Running in GitHub Codespaces (works from a phone)

1. On github.com, open this repository and tap **Code → Codespaces → Create codespace on
   main**. On a phone, use Safari's **aA → Request Desktop Website** if the button is hidden.
2. Wait for setup to finish. The first start takes a few minutes while it installs and patches
   the client. The server then starts on its own, and again every time the codespace resumes.
3. Open the **Ports** tab, then the globe icon (Open in Browser) next to port 3000. The link
   only works for your GitHub account, because Codespaces ports are private by default.

For the owner account, add a Codespaces secret named `OWNER_EMAILS` with your email (GitHub
**Settings → Codespaces → Secrets**, allowed for this repository) before creating the codespace.
Codespaces stops after 30 minutes without activity, and free accounts get 60 hours a month.

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
`./data`), `ASSETS_DIR` (default `./assets`), `DOWNLOAD_ASSETS=0` (skip the asset download at
startup), `MAP_FILE` (recorded map, default `data/map.json`). `/__health` answers without the password and shows the running commit (`ok 1a2b3c4`),
so you can check a deploy is up to date. The page and scripts are sent with
`Cache-Control: no-store`, so a redeploy reaches players on their next visit.

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
  islands. There are flytraps and healing stones, a giant cake with balloons in land, desert and
  arctic (party foods around it: crumbs, cookies, cupcakes, cake slices, gifts), slingshots with
  balloons, and beehives by land trees. Each world has about 1,600 foods across 45 kinds, from
  berries to mushroom bushes, eggs, melons, conches and cacti. As in mope.io, each food can only be eaten by the
  tiers in the client's own table (berries up to tier 8, watermelons from tier 11, and so on).
  Eaten food comes back after a few seconds. To play on mope.io's real map instead, record it (see
  [The real mope.io map](#the-real-mopeio-map)).
- **Custom biomes:** four biomes mope.io doesn't have, each with a full tier 1–17 animal ladder
  (68 new animals) and 7 foods of its own, drawn in mope.io's style:
  - **Swamp:** a murky area in the south-east of the land biome, with mud, puddles and ponds.
    From Tadpole and Dragonfly up to Anaconda, Bog Troll, Swamp Monster and the three-headed
    Hydra.
  - **Underground:** a cave world. Enter through the big tunnel holes, two in each surface
    biome. Earthworm and Cave Cricket up to Crystal Golem, Magma Worm and Earth Titan.
  - **Sky:** cloud world. A slingshot pulled back nearly all the way flings you into it, and
    gaps in the clouds drop you back down. Butterfly and Hummingbird up to Griffin, Pegasus, Sky
    Whale and Storm Dragon.
  - **Space:** fly off the top edge of the sky. Wormholes take you back to the sky. Star Mite
    and Moon Moth up to Cosmic Whale, Solar Phoenix and Galaxy Dragon.

  The new animals show up in the upgrade menus next to the classic ones. Picking one takes you
  to its world, and picking a surface animal brings you back. Every region (and party) has its
  own underground, sky and space. `/layer <name>` jumps between them. Everything comes from
  `custom-biomes.json`. `patch-client.ts` adds it to the client, and
  `python3 tools/make-biome-art.py` redraws the sprites into `custom-assets/` after you change
  it.
- **Combat:** animals bite by mope.io's own rule. A higher tier eats animals down to about half
  its tier (the red and green circles show who), and tier 15+ animals can bite the tail of their
  own tier. Bites take more health the bigger the tier gap, and health comes back after a few
  seconds out of a fight. A kill gives a quarter of the victim's XP (at least five foods' worth)
  and leaves meat. The death screen shows who ate you. New animals get 3 seconds of spawn
  immunity.
- **Abilities (W or right click), for every animal including the custom ones:** mope.io runs a
  different ability for nearly every animal on its own servers. Here each animal's ability name
  picks one of these effects (`abilities.js`), and the client plays the animal's own animation
  while it's on:
  - **dash:** charge, pounce, lunge, slide. Hits whoever you run into.
  - **jump:** a short hop over things.
  - **fly:** fly, hover, glide or soar while held. Untouchable, but you can't eat.
  - **shell:** turtles, armadillos, disguises. Immune and still.
  - **spikes:** hedgehog, pufferfish. Shell, plus it hurts anyone touching you.
  - **burrow:** dig hole, burrow, tunnel. Hidden and slow.
  - **strike / claw / grab / venom:** a hit in front. Claws make the target bleed, grabs
    constrict and stun, venom poisons.
  - **fire:** burns in front of you. **freeze**, **shock**, **quake**, **web** and **poison**
    hit everyone around you.
  - **gust:** blows animals away. **pull:** black holes and whirlpools drag them in.
  - **stun:** roar, howl, squawk. Stuns your tier and below.
  - **heal:** heal over time. **forage:** dig up food. **push:** spit water.
  - **dive:** dive under water.

  The dive button lets water animals dive in water while oxygen lasts, and climbing animals
  climb trees with the climb button, safe from animals that can't climb. Cooldowns show on the
  buttons.
- **Terrain:** small animals hide in holes, where bigger ones can't bite them, and pop out
  when they leave. Bushes hide you from animals that can't get through them. Rocks block animals
  that can't climb them, healing stones heal you while you stand on them, and flytraps snap at
  tier 1-4 animals (a stun and a bite).
- **Rare animals:** earned upgrade menus roll each animal's rare forms by the client's own odds,
  so the card shows its rarity (a White Lion, a Dove, …). A rare pick is announced to the whole
  region, pays 25 coins and counts on the **Rare animals found** board.
- **Coins:** MopeCoins for kills (2 + the victim's tier), natural tier-ups (the tier), rares
  (25), goals (5), casual and ranked 1v1 wins (10 and 20), Battle Royale wins (50), bosses
  (100) and tournaments (200). They show on the HUD and the death screen, and go into a
  signed-in account's balance for the shop.
- **AI bots:** every region's FFA world has `BOTS` of them (default 8), Teams and Battle Royale
  worlds a few. They eat, drink, run from predators, hunt prey, use abilities, upgrade,
  respawn and accept most 1v1 requests. They show on the in-game leaderboard but never on the
  worldwide boards or the server list's counts. `/bots <n>` changes the number for the world
  you're in.
- **World events** (each FFA world, every 6-10 minutes while people play; `/event <name>` starts
  one):
  - **double:** Double XP for 3 minutes.
  - **meteors:** a meteor shower of ten impacts. Each hurts animals nearby, leaves a lava
    crater for a few seconds and scatters treats.
  - **pumpkins:** a pumpkin rush of 12 rare pumpkins.
  - **boss:** a tier 16 monster that takes a fifth of normal damage for 5 minutes. Eating it
    pays 5× XP and 100 coins.
- **Water and lava:** the bar drains slowly (faster while boosting or flying). Water animals
  refill in any water, lava animals in the volcano and lava pools, and every food tops it up a
  little (water, melons and kelp more). Running dry costs health.
- **Game modes** (the menu's mode list, in every region):
  - **FFA** and **PARTY** as before, plus **casual 1v1s**: at tier 15+ (signed in), use the 1v1
    button or `/1v1 <player>`. If they accept, you fight in the arena ring: 3 s countdown, 90 s
    fight, and the ring closes in. The loser is eaten, and the winner gets a win and bonus XP.
    Ratings don't change.
  - **1V1 RANKED:** pick a tier 15-17 fighter and you're matched with the closest rating. Elo
    (K 32, start 1000) with ranks Bronze, Silver (1100), Gold (1250), Platinum (1400),
    Diamond (1550) and Champion (1700). `/rank` shows yours, and the menu Leaderboard has a
    **Ranked 1v1 rating** board.
  - **BATTLE ROYALE:** a round starts 15 s after two players are in. The ring shrinks over 4
    minutes and hurts anyone outside, and the last animal standing wins (**Battle Royale
    wins** board).
  - **TEAMS:** Red and Blue, names in team colours, no friendly fire. Team XP is announced and
    `/team` shows it.
  - **SANDBOX:** try any animal with ▲/▼. Nobody can be hurt, the water bar doesn't drain, and
    nothing counts for the boards.
- **Tournaments (staff-run):** `/tournament open <4|8|16> [prize XP]`, players `/join`, then
  `/tournament start`. Each round is played in 1v1 arenas at the same time. Tournament fights
  aren't lethal (a timeout goes to the healthier animal), and the champion gets the prize and a
  **Tournament wins** board entry. `/tournament` shows the state and `/tournament cancel`
  stops it.
- **Giant cake:** walk onto it to climb its three layers. Each layer makes you 12% bigger and
  widens your view. Whoever has held the top layer longest is king of the cake and earns three
  foods' worth of XP every 5 s. The cake keeps putting out party food around it, up to 30 at a
  time: crumbs and cookies, then cupcakes, cake slices and gifts the higher anyone stands.
- **Slingshots:** walk onto the pad to load it, then move back to pull the band (it turns red as
  it stretches). Point forward or boost to let go, and you fly the way the slingshot faces: up to
  about 3,300 units at full pull. Walking off forward without pulling unloads it. `/pos` shows
  the nearest cake and slingshot, and which way it faces.
- **XP cap:** 10 trillion (`limits.js`). mope.io sends XP as a 32-bit number, which stops at
  4.29 billion, so the client patch turns it into a 64-bit value. At tier 17 the XP bar shows
  progress toward the cap ("1.5B XP / 10T XP"), filled on the same log scale as the growth.
- **Upgrades, tiers 1–17:** eating earns XP, and when it reaches the next tier the upgrade menu
  opens with that tier's animals. `TIER_XP` in `limits.js` replaces mope.io's table (which
  stops at 10M): 100 XP for tier 2, then about ×4.64 per tier up to 1T for tier 17 (460, 2.2K,
  10K, 46K, 220K, 1M, 4.6M, 22M, 100M, 460M, 2.2B, 10B, 46B, 220B, 1T). Each tier takes about
  30 foods. At tier 17 each food is worth 1/300 of the way to the 10T cap.
- **Movement and rotation:** animals face the way they move (the client turns them smoothly).
  Speed scales with how far the pointer or joystick is pushed. Each animal's own
  `terrainSpeedComfort` from the client sets its speed on land, in water (oceans, lakes, puddles,
  the river) and in mud: a shrimp is fast in water and slow on land, a mouse is half speed in
  water. On arctic ground animals slide according to their `iceGrip`. Space or click boosts,
  with each animal's `boostCooldown`. mope.io's base speed isn't in the client, so the server
  uses its own value: 352 at tier 1, slowing to 224 at tier 17.
- **Size:** every animal grows between its minimum and maximum size, from the client's own size
  table (forms with their own range use it). Tiers 1–16 reach 75% of the range by the next
  tier's XP, where normal play upgrades. Staying on the tier, they keep growing on a log scale
  (each ×10 in XP adds the same amount) until the tier's cap. The caps halve down from tier
  17: 10T, 5T, 2.5T, … 153M for tier 1. Tier 17 grows on a log scale from 1T to 10T. Losing XP
  shrinks the animal, upgrading starts the new animal at its tier's minimum, `/size <n>` pins
  a size, and `/size auto` hands it back to XP.
- **Pumpkins:** 45 per world on land, arctic and desert. They can't be eaten: walking into one
  pushes it so it rolls ahead of you, and boosting into it kicks it hard. The XP comes from
  rolling it into a hole (a goal). Rare ones (gold and up) show on the minimap. `pumpkins.js`
  sets every variant's spawn chance and goal XP at tier 17. Each lower tier gets half of the tier above
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

  The bold ones are custom.
- **Pumpkin goals:** push or kick a pumpkin, or `/shoot` one, into a hole. A goal gives
  whoever touched it last the pumpkin's XP, a new one appears 30 s later, the hole shows "GOAAAAL!!!" and then the scorer's
  name, all-time goal count and bonus XP, and chat announces it.
- **Leaderboards:** the in-game top 10 (top left) ranks everyone in your world by XP. The menu
  **Leaderboard** tile has two worldwide boards, **Most XP** (the highest XP each player has
  reached) and **Pumpkin goals**, each for this week, this month and all time. They cover every
  region and party, and are saved in `data/records.json`. Signed-in players are tracked by
  account, guests by name. `/top` prints the all-time leaders in chat. `tools/make-pumpkins.py` builds their textures from ruby's 5
  rolling frames and the artwork in `custom-assets/source/`.
- **Sandbox buttons and keys:** the on-screen **▲ Upgrade** / **▼ Downgrade** buttons (right
  side, shown while playing on a local server) and the **Up**/**Down** keys step the upgrade menu through all 17 tiers, from Mouse to
  Black/King Dragon. Click an animal, or press its number key (the keys reach the first nine
  cards; click the rest). In the console, `localtest.up(n)` / `localtest.down(n)` do the same.
  Picking a higher-tier animal this way (or with `/animal`) raises your XP to that tier's
  requirement, so the XP bar and size match the animal. Picking a lower one keeps your XP, and
  the automatic upgrade menu waits until you earn past a new tier.

## The real mope.io map

mope.io's server decides where everything is, and it isn't in the client, so the map has to be
recorded from a real game. Open **/map-recorder** on your server and follow the three steps:

1. Add the **Mope map recorder** bookmark. On a computer, drag the button to the bookmarks bar.
   On iPhone, bookmark any page, edit it and paste the code from the page as its address.
2. On mope.io, tap the bookmark, then **Reconnect** in the black box, then the game's
   **Try Again**. Play and travel through every biome while the box counts what it has seen,
   then press **Save map file** (`mope-map.json`).
3. Upload the file on /map-recorder while signed in as an owner. Every region switches to it
   straight away, and it's saved to `data/map.json` (or `MAP_FILE`) for restarts.
   **Back to generated map** undoes it.

Objects and foods are replayed exactly as mope.io sent them. Pumpkins and animals aren't
recorded, and food left by players (carcasses, coins, gems) is ignored. On hosts without a
persistent disk (Render free), the file is lost on each redeploy, so upload it again.

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
| `/help`, `/top`, `/1v1 <player>`, `/rank`, `/team`, `/join`, `/tournament` | everyone |
| `/players`, `/kick <player>` | moderator |
| `/ban <player> [minutes]`, `/unban <email>` | trusted moderator |
| `/announce <message>` | event team |
| `/shoot [variant] [count]` fires pumpkins the way you face (they roll and stop, and vanish after a minute if they don't score; animals they hit get knocked back), `/pumpkin <variant> [count]`, `/animal <name> [subspecies]`, `/tier <n>`, `/xp <n>`, `/size <n>`, `/speed <x>`, `/zoom <x>`, `/god`, `/tp <x> <y>` or `/tp <player>`, `/pos` (your position and the nearest hole, cake and slingshot), `/face <degrees>`, `/layer <surface|underground|sky|space>`, `/bring <player>`, `/spawn <food> [count]`, `/clearfood`, `/kill [player]` | admin |
| `/bots <n>`, `/event <double|meteors|pumpkins|boss>` | admin |
| `/coins <n> [email]`, `/gems <n> [email]`, `/role <email> <0-5>` | developer |

## Files

| File | What it does |
| --- | --- |
| `fetch-mope.ts`, `pretty.ts` | Download mope.io's client into `mope-dump/` and format it |
| `patch-client.ts` | Points the client at this server: regions, account API, skins |
| `server.js` | HTTP server: client, assets, `/api` accounts, `/play` game sockets |
| `game-server.js` | Game protocol and lobbies (spawn, move, eat, upgrades, chat) |
| `world.js` | Generates each lobby's terrain and foods, or loads a recorded map |
| `map-recorder.js` | The /map-recorder page and the bookmarklet that records mope.io's map |
| `pumpkins.js`, `tools/make-pumpkins.py`, `custom-assets/` | Pumpkin variants, their chances and XP, and the custom textures |
| `custom-biomes.json`, `custom-biomes.js`, `tools/make-biome-art.py` | Swamp, underground, sky and space: their animals, foods, colours, and the sprite generator |
| `parties.js` | Party lobbies and invite codes |
| `records.js` | Worldwide Most XP and Pumpkin goals boards (weekly, monthly, all time) |
| `bots.js`, `events.js` | AI animals, and the world events |
| `abilities.js` | Abilities, diving and tree climbing |
| `modes.js`, `mode-list.js` | 1v1 arenas, ranked Elo, tournaments, Battle Royale, Teams, Sandbox |
| `accounts.js` | Account database, email login, local version of Mope's account/shop API |
| `dev-commands.js` | Chat commands and the client's staff tools |
| `regions.js` | The region list |
| `limits.js` | The XP cap, shared by the server and the client patch |
| `site-gate.js` | Site-wide password for hosted copies (`SITE_PASSWORD`) |
| `Dockerfile`, `railway.json` | Railway / Docker deployment |
| `render.yaml` | Render (free plan) |
| `docker-compose.yml`, `.env.example` | Your own machine + Cloudflare Tunnel |
| `.devcontainer/devcontainer.json` | GitHub Codespaces: sets up and starts the server |
| `client-runtime.js` | Loads the client's own protocol code so the server encodes exactly like it |
| `asset-catalog.js` | Lists every asset from the client's tables and downloads it into `assets/<Category>/` |

Asset categories: Animals, UI, Shop Skins, Foods, Game Object Assets, Biomes, Biome Terrains,
Abilities. Abilities holds every ability texture and animation frame: the base ones from
mope.io and every ability skin on S3, for example all 24 fireball skins with their 10 frames.
Open `/gallery` to browse them. `POST /api/refresh` re-runs the download.

Behind an HTTP proxy, start Node with `NODE_USE_ENV_PROXY=1` so its `fetch` uses it.

The server relies on internal names in the minified client build. A new mope.io release can
rename them, and then `bun run setup` would need the server updated to match.
