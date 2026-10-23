// Site-wide password for hosted deployments (SITE_PASSWORD). Until a visitor enters it, every
// page, file, API call and game connection is refused, so mope.io's client and art are only
// served to people you've given the password. The password is checked once on a form and then
// remembered in a cookie, which browsers also send with the game's WebSocket connection.
import crypto from "node:crypto";

const COOKIE = "site_gate";
const DAYS = 30;

export function createGate(password) {
  if (!password) return null;
  const token = crypto.createHmac("sha256", password).update("silver-frontier site gate").digest("hex");

  const cookie = (req) =>
    (req.headers.cookie ?? "").split(";").map((c) => c.trim().split("=")).find(([k]) => k === COOKIE)?.[1] ?? "";
  const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const allowed = (req) => same(cookie(req), token);
  const page = (error = "") => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Private server</title><style>
:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#1d6b2a;font:15px system-ui,sans-serif}
form{background:#fff;color:#123;padding:24px;border-radius:14px;width:min(320px,calc(100vw - 32px));box-shadow:0 8px 30px #0004}
h1{margin:0 0 14px;font-size:20px}input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #bcd;border-radius:8px;font-size:15px}
button{margin-top:12px;width:100%;padding:11px;border:0;border-radius:8px;background:#2fbf46;color:#fff;font-weight:700;font-size:16px;cursor:pointer}
.err{color:#c22;margin-top:10px;font-size:13px;min-height:1.2em}</style></head>
<body><form method="post" action="/__gate"><h1>Private server</h1>
<input type="password" name="password" placeholder="Password" autofocus required>
<button>Enter</button><div class="err">${error}</div></form></body></html>`;

  return {
    // Handles the request when the visitor hasn't entered the password; returns true if it did.
    async handle(req, res, pathname) {
      if (pathname === "/__gate" && req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const given = new URLSearchParams(body).get("password") ?? "";
        if (same(crypto.createHmac("sha256", given).update("silver-frontier site gate").digest("hex"), token)) {
          const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
          res.writeHead(303, { Location: "/", "Set-Cookie": `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DAYS * 86400}${secure}` });
          res.end();
        } else {
          res.writeHead(401, { "Content-Type": "text/html" });
          res.end(page("Wrong password."));
        }
        return true;
      }
      if (allowed(req)) return false;
      const wantsPage = req.method === "GET" && (req.headers.accept ?? "").includes("text/html");
      res.writeHead(401, { "Content-Type": wantsPage ? "text/html" : "text/plain" });
      res.end(wantsPage ? page() : "password required");
      return true;
    },
    allowed,
  };
}
