// The in-game changelog: every commit in the version that is running, newest first, in the shape
// the client's changelog box reads ({ versions: [{ version, date, title, sections }] }). The
// patched client fetches it from /api/changelog instead of showing mope.io's own notes.
//
// Commits come from the local git history when there is one; otherwise (Docker builds leave .git
// out) from GitHub, starting at the deployed commit. The repository is the host's
// (RENDER_GIT_REPO_SLUG, RAILWAY_GIT_REPO_OWNER/NAME) or CHANGELOG_REPO, else package.json's.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CACHE_MS = 10 * 60_000;
const MAX_COMMITS = 300;
const SKIP_LINE = /^(Co-Authored-By|Claude-Session|Signed-off-by):/i;

// A commit message's body as changelog items: "- " bullets (with their wrapped lines), or each
// paragraph as one item.
function items(body) {
  const out = [];
  let cur = null;
  for (const raw of body.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim() || SKIP_LINE.test(line.trim())) {
      if (cur) out.push(cur), (cur = null);
      continue;
    }
    if (/^\s*[-*] /.test(line)) {
      if (cur) out.push(cur);
      cur = line.replace(/^\s*[-*] /, "");
    } else cur = cur ? `${cur} ${line.trim()}` : line.trim();
  }
  if (cur) out.push(cur);
  return out;
}

const typeOf = (subject) => (/^fix/i.test(subject) ? "fix" : /^(add|new)/i.test(subject) ? "new" : "change");

function toVersion({ sha, date, subject, body }) {
  const list = items(body);
  return {
    version: sha.slice(0, 7),
    date,
    title: subject,
    sections: list.length ? [{ type: typeOf(subject), items: list }] : [],
  };
}

function fromGit(root) {
  if (!fs.existsSync(path.join(root, ".git"))) return null;
  const out = execFileSync("git", ["log", `-n${MAX_COMMITS}`, "--date=short", "--format=%H%x1f%ad%x1f%s%x1f%b%x1e"], { cwd: root, encoding: "utf8" });
  return out.split("\x1e").map((c) => c.trim()).filter(Boolean).map((c) => {
    const [sha, date, subject, body = ""] = c.split("\x1f");
    return { sha, date, subject, body };
  });
}

async function fromGitHub(repo, sha) {
  const commits = [];
  for (let page = 1; commits.length < MAX_COMMITS && page <= 3; page++) {
    const url = `https://api.github.com/repos/${repo}/commits?sha=${encodeURIComponent(sha || "HEAD")}&per_page=100&page=${page}`;
    const res = await fetch(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "silver-frontier" } });
    if (!res.ok) break;
    const list = await res.json();
    for (const c of list) {
      const [subject, ...rest] = c.commit.message.split("\n");
      commits.push({ sha: c.sha, date: (c.commit.author?.date ?? "").slice(0, 10), subject, body: rest.join("\n") });
    }
    if (list.length < 100) break;
  }
  return commits.length ? commits : null;
}

export function createChangelog({ root }) {
  const repo = process.env.CHANGELOG_REPO ?? process.env.RENDER_GIT_REPO_SLUG
    ?? (process.env.RAILWAY_GIT_REPO_OWNER && `${process.env.RAILWAY_GIT_REPO_OWNER}/${process.env.RAILWAY_GIT_REPO_NAME}`)
    ?? (() => {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).repository;
        return String(r?.url ?? r ?? "").match(/github\.com[/:]([^/]+\/[^/.]+)/)?.[1] ?? null;
      } catch {
        return null;
      }
    })();
  const sha = process.env.RENDER_GIT_COMMIT ?? process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA ?? "";
  let cached = null, at = 0;
  return async function changelog() {
    if (cached && Date.now() - at < CACHE_MS) return cached;
    let commits = null;
    try { commits = fromGit(root); } catch {}
    if (!commits && repo) try { commits = await fromGitHub(repo, sha); } catch {}
    cached = { versions: (commits ?? []).map(toVersion) };
    at = Date.now();
    return cached;
  };
}
