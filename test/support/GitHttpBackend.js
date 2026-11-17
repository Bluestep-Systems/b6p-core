// Test support (not a spec; `npm test` does not run it): a real git smart-HTTP backend for the
// gateway git specs. It mounts `git http-backend` (git's own CGI) on a FakeGateway under
// /api/v1/git, over bare repositories in a temp folder, the way the gateway's proxy fronts the
// forge. Needs a `git` on PATH (every dev machine and GitHub runner has one); isomorphic-git has no
// server side to use instead.
//
// Mimics the contract's proxy rules: receive-pack needs the push scope (403 scope-missing
// otherwise), force pushes and ref deletions are refused (git's denyNonFastForwards/denyDeletes).

const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const GIT_PREFIX = "/api/v1/git";

/** Run git synchronously with a fixed identity and no autocrlf; returns trimmed stdout. */
function git(cwd, ...args) {
  return execFileSync(
    "git",
    ["-c", "user.name=Spec", "-c", "user.email=spec@example.invalid", "-c", "core.autocrlf=false", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  ).trim();
}

function tokenOf(header) {
  return header && header.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
}

/**
 * @param fake a started FakeGateway
 * @param pushTokens tokens allowed to use receive-pack
 * @param readScope the scope a fetch needs (`registry:read` for a marketplace-only fake)
 * @returns {{ root: string, rejectPushWith409: boolean, bare(org, repo): string, cleanup(): void }}
 */
function mountGitBackend(fake, pushTokens, readScope = "kb:read") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "b6p-gitsrv-"));
  const state = {
    root,
    rejectPushWith409: false,
    /** When set, a receive-pack POST is answered with a forged report: `ng <ref> <this text>`. */
    forgePushRejection: undefined,
    bare(org, repo) {
      return path.join(root, org, `${repo}.git`);
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };

  const handler = (req, res) => {
    const url = new URL(req.url, "http://x");
    const isReceive =
      url.pathname.endsWith("git-receive-pack") || url.searchParams.get("service") === "git-receive-pack";
    if (isReceive) {
      if (!pushTokens.has(tokenOf(req.headers.authorization))) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "scope-missing", message: "The token lacks kb:push.", scope: "kb:push" }));
        return Promise.resolve();
      }
      if (state.rejectPushWith409 && req.method === "POST") {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "non-fast-forward", message: "Not a fast-forward." }));
        return Promise.resolve();
      }
    }
    if (isReceive && req.method === "POST" && state.forgePushRejection !== undefined) {
      const pkt = (text) =>
        Buffer.from(
          String(Buffer.byteLength(text) + 4).length
            ? (Buffer.byteLength(text) + 4).toString(16).padStart(4, "0") + text
            : ""
        );
      res.writeHead(200, { "Content-Type": "application/x-git-receive-pack-result" });
      res.end(
        Buffer.concat([
          pkt("unpack ok\n"),
          pkt(`ng refs/heads/master ${state.forgePushRejection}\n`),
          Buffer.from("0000"),
        ])
      );
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        const cgi = spawn("git", ["http-backend"], {
          env: {
            ...process.env,
            GIT_PROJECT_ROOT: root,
            GIT_HTTP_EXPORT_ALL: "1",
            REQUEST_METHOD: req.method,
            PATH_INFO: url.pathname.slice(GIT_PREFIX.length),
            QUERY_STRING: url.search.slice(1),
            CONTENT_TYPE: req.headers["content-type"] ?? "",
            CONTENT_LENGTH: String(body.length),
            REMOTE_USER: "spec",
            REMOTE_ADDR: "127.0.0.1",
            GIT_CONFIG_COUNT: "3",
            GIT_CONFIG_KEY_0: "http.receivepack",
            GIT_CONFIG_VALUE_0: "true",
            GIT_CONFIG_KEY_1: "receive.denyNonFastForwards",
            GIT_CONFIG_VALUE_1: "true",
            GIT_CONFIG_KEY_2: "receive.denyDeletes",
            GIT_CONFIG_VALUE_2: "true",
          },
        });
        const out = [];
        cgi.stdout.on("data", (c) => out.push(c));
        cgi.stderr.on("data", () => {});
        cgi.on("close", () => {
          const raw = Buffer.concat(out);
          const sep = raw.indexOf("\r\n\r\n");
          const head = raw.subarray(0, sep).toString("utf8").split("\r\n");
          let status = 200;
          const headers = {};
          for (const line of head) {
            const colon = line.indexOf(":");
            const name = line.slice(0, colon).trim();
            const value = line.slice(colon + 1).trim();
            if (name.toLowerCase() === "status") {
              status = parseInt(value, 10);
            } else {
              headers[name] = value;
            }
          }
          res.writeHead(status, headers);
          res.end(raw.subarray(sep + 4));
          resolve();
        });
        cgi.stdin.end(body);
      });
    });
  };
  fake.route({ method: "GET", prefix: GIT_PREFIX + "/", scope: readScope, handler });
  fake.route({ method: "POST", prefix: GIT_PREFIX + "/", scope: readScope, handler });
  return state;
}

/**
 * Create `org/repo.git` (bare, default branch master) holding `files` ({ name: string | Buffer })
 * in one commit; returns the bare path.
 */
function seedRepo(state, org, repo, files) {
  const bare = state.bare(org, repo);
  fs.mkdirSync(bare, { recursive: true });
  git(bare, "init", "--bare", "-b", "master", ".");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "b6p-gitwork-"));
  git(work, "init", "-b", "master", ".");
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(work, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  git(work, "add", "-A");
  git(work, "commit", "-m", "seed");
  git(work, "push", bare, "master");
  fs.rmSync(work, { recursive: true, force: true });
  return bare;
}

/** Commit `files` onto `branch` of the bare repo through a throwaway clone; returns the new head. */
function commitToRemote(bare, branch, files, message = "remote change") {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "b6p-gitwork-"));
  try {
    git(work, "clone", "-q", bare, ".");
    const exists = git(work, "branch", "-a", "--list", `origin/${branch}`);
    if (exists) {
      git(work, "checkout", "-q", branch);
    } else {
      git(work, "checkout", "-q", "-b", branch);
    }
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(work, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    git(work, "add", "-A");
    git(work, "commit", "-m", message);
    git(work, "push", "-q", "origin", branch);
    return git(work, "rev-parse", "HEAD");
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = { mountGitBackend, seedRepo, commitToRemote, git };
