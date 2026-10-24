// The server list's game modes: [mode, label shown in the client, URL suffix after /play/<region>].
// FFA and PARTY are the client's own; the rest are run by modes.js. Kept apart from modes.js so
// the client patch can read it without loading the game server.
export const MODE_LIST = [
  ["FFA", "FFA", ""],
  ["PARTY", "PARTY", "/new"],
  ["RANKED", "1V1 RANKED", "/m/ranked"],
  ["BR", "BATTLE ROYALE", "/m/br"],
  ["TEAMS", "TEAMS", "/m/teams"],
  ["SANDBOX", "SANDBOX", "/m/sandbox"],
];
export const MODE_BY_SLUG = { ranked: "RANKED", br: "BR", teams: "TEAMS", sandbox: "SANDBOX" };
