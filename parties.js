// Party mode: private lobbies reached through invite links.
//
// Every region has a PARTY game mode next to FFA. Joining it opens a new private lobby with a
// short code; the client turns that code into an invite link (?server=…&mode=PARTY&inviteID=…).
// Whoever opens the link connects to the same region's PARTY server and is moved into the
// party when they press Play. Empty parties close after a minute.
import crypto from "node:crypto";
import { Lobby } from "./game-server.js";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_PLAYERS = 30;
const EMPTY_GRACE_MS = 60_000;

export function createParties() {
  const byCode = new Map();

  const newCode = () => {
    let code;
    do code = Array.from(crypto.randomBytes(6), (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
    while (byCode.has(code));
    return code;
  };

  return {
    // `/play/<region>/new` opens a fresh party; `/play/<region>/<code>` joins one directly.
    join(region, code) {
      if (code === "new") {
        const lobby = new Lobby(region, { mode: "PARTY", party: newCode() });
        byCode.set(lobby.party, lobby);
        return lobby;
      }
      const lobby = byCode.get(code.toUpperCase());
      return lobby && lobby.players.size < MAX_PLAYERS ? lobby : null;
    },
    get(code) {
      const lobby = byCode.get(String(code).toUpperCase());
      return lobby && lobby.players.size < MAX_PLAYERS ? lobby : null;
    },
    leave(lobby) {
      if (lobby.occupancy) return; // players here or in its layer worlds
      setTimeout(() => {
        if (lobby.occupancy || byCode.get(lobby.party) !== lobby) return;
        lobby.close();
        byCode.delete(lobby.party);
      }, EMPTY_GRACE_MS);
    },
    lobbies: () => [...byCode.values()],
  };
}
