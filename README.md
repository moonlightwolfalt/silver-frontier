# silver-frontier

Local copy of the mope.io client, its assets, and a sandbox server to run it against.

```
bun install
bun run setup    # fetch the mope.io client, prettify it, patch in the LOCALTEST region
bun run start    # http://localhost:3000 — generates assets/, starts the sandbox game server
```

Pick **LOCALTEST** in the server list and press Play. In game, **Up**/**Down** open the
upgrade menu for the next/previous tier and **1–9** pick an animal. From the console,
`localtest.up(n)` / `localtest.down(n)` do the same.

| File | What it does |
| --- | --- |
| `fetch-mope.ts` | Downloads mope.io's page, scripts and styles into `mope-dump/` |
| `pretty.ts` | Formats the downloaded client with Prettier |
| `patch-client.ts` | Adds the LOCALTEST region and `localtest` helpers, points skins at the local server |
| `asset-catalog.js` | Lists every asset from the client's own tables and downloads it into `assets/<Category>/` |
| `server.js` | Serves the client and the generated assets; `/gallery` shows them by category |
| `game-server.js` | Minimal sandbox game server (spawn, move, upgrade/downgrade) on port 8443 |
| `client-runtime.js` | Loads the client's protocol code so the game server encodes messages exactly like it |

Categories: Animals, UI, Shop Skins, Foods, Game Object Assets, Biomes, Biome Terrains.
Base textures come from `mope.io/assets/`, skins from `s3.mope.io/mope-prod/items/`.
`POST /api/refresh` re-runs the asset generator; known misses are cached in `assets/.misses.json`.

Behind an HTTP proxy, start Node with `NODE_USE_ENV_PROXY=1` so its `fetch` uses it.
