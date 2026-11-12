// A tiny in-test stand-in for the platform's git proxy (GitProxyController) and publish mutation.
//
// It serves real bare repos over smart HTTP by running `git http-backend` as a CGI behind node:http, and mimics the
// proxy's gates: Basic auth with a b6pt_ password (else 401 + challenge), 404 for an unknown repo, 403 with the
// gate's reason for a push to a WEBDAV-mode or code-locked script, and a pre-receive hook standing in for the forge's
// protected master. POST /gql with takeSnapshot fast-forwards master to draft the way publishFromGit does.
// Hermetic: loopback only, temp dirs, no Bluestep server.

const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");

const SESSION = "JSESSIONID=stub-session";
const CSRF = "csrf-abc";
const TOKEN = "b6pt_good-token";

function git(cwd, ...args) {
  return gitEnv(cwd, {}, ...args);
}

function gitEnv(cwd, extraEnv, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...extraEnv, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_SYSTEM: os.devNull },
  }).trim();
}

function httpBackendPath() {
  return path.join(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(), "git-http-backend");
}

/** Creates the temp area, a bare repo `<classid>___<seqnum>` seeded with one commit on master and draft. */
function createStub() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bsjs-git-stub-"));
  const repos = new Map(); // name -> { mode, locked, refusePublish }
  const backend = httpBackendPath();

  function addRepo(name, { mode = "GIT", locked = false, files = { "main.ts": "export const v = 1;\n" } } = {}) {
    const bare = path.join(root, name);
    git(root, "init", "--bare", "-b", "master", bare);
    git(bare, "config", "http.receivepack", "true");
    git(bare, "config", "http.uploadpack", "true");
    fs.writeFileSync(
      path.join(bare, "hooks", "pre-receive"),
      '#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = "refs/heads/master" ]; then\n    echo "protected branch" >&2\n    exit 1\n  fi\ndone\n',
      { mode: 0o755 }
    );
    const seed = fs.mkdtempSync(path.join(root, "seed-"));
    git(seed, "init", "-b", "master");
    git(seed, "config", "user.name", "Seeder");
    git(seed, "config", "user.email", "seed@example.test");
    for (const [file, text] of Object.entries(files)) {
      fs.writeFileSync(path.join(seed, file), text);
    }
    git(seed, "add", "-A");
    git(seed, "commit", "-m", "Seed master");
    git(seed, "branch", "draft");
    // The hook would refuse master, so seed through a hook-free path.
    const hook = path.join(bare, "hooks", "pre-receive");
    const saved = fs.readFileSync(hook);
    fs.rmSync(hook);
    git(seed, "push", bare, "master", "draft");
    fs.writeFileSync(hook, saved, { mode: 0o755 });
    repos.set(name, { mode, locked, refusePublish: undefined, bare });
    return bare;
  }

  function authorized(header, scheme) {
    if (!header) {
      return false;
    }
    if (scheme === "Basic") {
      if (!/^Basic /i.test(header)) {
        return false;
      }
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
      return decoded.slice(decoded.indexOf(":") + 1) === TOKEN;
    }
    return header === `Bearer ${TOKEN}`;
  }

  function cgi(req, res, name, rest, query) {
    const body = [];
    req.on("data", (c) => body.push(c));
    req.on("end", () => {
      const input = Buffer.concat(body);
      const child = spawn(backend, [], {
        env: {
          PATH: process.env.PATH,
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: "1",
          REQUEST_METHOD: req.method,
          PATH_INFO: `/${name}/${rest}`,
          QUERY_STRING: query,
          CONTENT_TYPE: req.headers["content-type"] || "",
          CONTENT_LENGTH: String(input.length),
          HTTP_CONTENT_ENCODING: req.headers["content-encoding"] || "",
          GIT_PROTOCOL: req.headers["git-protocol"] || "",
          REMOTE_USER: "tester",
          REMOTE_ADDR: "127.0.0.1",
          GIT_CONFIG_GLOBAL: os.devNull,
          GIT_CONFIG_SYSTEM: os.devNull,
        },
      });
      child.stdin.end(input);
      const out = [];
      child.stdout.on("data", (c) => out.push(c));
      child.on("close", () => {
        const raw = Buffer.concat(out);
        const split = raw.indexOf("\r\n\r\n");
        const headText = raw.subarray(0, split).toString("utf8");
        const status = /^Status: (\d+)/m.exec(headText);
        const headers = {};
        for (const line of headText.split("\r\n")) {
          const i = line.indexOf(":");
          if (i > 0 && !/^status$/i.test(line.slice(0, i))) {
            headers[line.slice(0, i)] = line.slice(i + 1).trim();
          }
        }
        res.writeHead(status ? Number(status[1]) : 200, headers);
        res.end(raw.subarray(split + 4));
      });
    });
  }

  const state = {
    csrfRequests: 0,
    gqlRequests: 0,
    enableCalls: 0,
    modeQueries: 0,
    sessionGitRequests: 0,
    sessionAuthorizationSeen: false,
    rejectNextCsrf: false,
    failGitAfterPublish: false,
  };

  /** A signed-in browser session: the cookie alone, no Authorization header. */
  const hasSessionCookie = (req) => (req.headers.cookie || "").includes(SESSION);

  function gql(req, res) {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (!authorized(req.headers.authorization, "Bearer") && !hasSessionCookie(req)) {
        res.writeHead(401);
        res.end("{}");
        return;
      }
      // Production /gql enforces the CSRF header (bound to the session cookie) on every call, bearer included.
      state.gqlRequests++;
      const hasSession = (req.headers.cookie || "").includes(SESSION);
      if (state.rejectNextCsrf || !hasSession || req.headers["b6p-csrf-token"] !== CSRF) {
        const forced = state.rejectNextCsrf;
        state.rejectNextCsrf = false;
        res.writeHead(403, forced ? { "B6P-CSRF-TOKEN": CSRF } : {});
        res.end("{}");
        return;
      }
      const { query, variables } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const read = /remoteObject\(id: \$id\) \{ \.\.\. on (\w+)/.exec(query);
      if (read) {
        // The real read: no write path, so it is answered without touching the script.
        state.modeQueries++;
        const target = repos.get(variables.id);
        const gitMode = target?.mode === "GIT";
        const typeOk = ["ScriptFormula", "ScriptMergeReport", "ScriptEndpoint"].includes(read[1]);
        res.end(
          JSON.stringify({
            data: {
              remoteObject:
                !target || !typeOk
                  ? {}
                  : {
                      gitPublishing: gitMode,
                      gitCloneUrl: gitMode ? `https://stub.example.test/git/${variables.id}` : null,
                    },
            },
          })
        );
        return;
      }
      const mutation = /\{\s*(\w+)\(inputs/.exec(query)[1];
      const input = variables.inputs[0];
      const entry = repos.get(input.topId);
      if (!entry) {
        res.end(JSON.stringify({ errors: [{ message: "no such script" }] }));
        return;
      }
      if (!input.takeSnapshot) {
        assert(input.enableGitPublishing === true, "only enableGitPublishing is a non-publish mutation here");
        state.enableCalls++;
        entry.mode = "GIT";
        const gitMode = entry.mode === "GIT";
        res.end(
          JSON.stringify({
            data: {
              [mutation]: [
                {
                  id: input.topId,
                  gitPublishing: gitMode,
                  gitCloneUrl: gitMode ? `https://stub.example.test/git/${input.topId}` : null,
                },
              ],
            },
          })
        );
        return;
      }
      if (entry.refusePublish) {
        res.end(
          JSON.stringify({
            errors: [
              {
                message: "The draft has no file for the registered entrypoint",
                extensions: {
                  code: "PUBLISH_REFUSED",
                  reason: entry.refusePublish,
                  publish: { entrypoint: "main.js" },
                },
              },
            ],
          })
        );
        return;
      }
      const draft = git(entry.bare, "rev-parse", "refs/heads/draft");
      git(entry.bare, "update-ref", "refs/heads/master", draft);
      state.failGitAfterPublish = entry.failFetchAfterPublish === true;
      res.end(JSON.stringify({ data: { [mutation]: [{ id: input.topId, config: { publishedSha: draft } }] } }));
    });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/gql") {
      gql(req, res);
      return;
    }
    if (url.pathname === "/csrf-token") {
      state.csrfRequests++;
      if (!authorized(req.headers.authorization, "Bearer") && !hasSessionCookie(req)) {
        res.writeHead(401);
        res.end();
        return;
      }
      res.writeHead(200, { "Set-Cookie": `${SESSION}; Path=/; HttpOnly`, "Content-Type": "text/plain" });
      res.end(CSRF);
      return;
    }
    const match = /^\/git\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (!match) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (!authorized(req.headers.authorization, "Basic") && hasSessionCookie(req) && !req.headers.authorization) {
      // The session lane: the cookie plus the CSRF header on every git request, none of the token machinery.
      state.sessionGitRequests++;
      if (req.headers["b6p-csrf-token"] !== CSRF) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("CSRF token missing or wrong");
        return;
      }
    } else if (!authorized(req.headers.authorization, "Basic")) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="BlueStep Git"', "Content-Type": "text/plain" });
      res.end("Authentication required");
      return;
    }
    if (state.failGitAfterPublish) {
      res.writeHead(502);
      res.end();
      return;
    }
    const entry = repos.get(match[1]);
    if (!entry) {
      res.writeHead(404);
      res.end();
      return;
    }
    const isPush = match[2] === "git-receive-pack" || url.searchParams.get("service") === "git-receive-pack";
    if (isPush && entry.locked) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("This code carries a fixed id or is frozen, so only a platform super administrator may change it.");
      return;
    }
    if (isPush && entry.mode !== "GIT") {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end(
        "push is not enabled: this script publishes over WebDAV (publishMode=WEBDAV) and its repo is a read-only mirror"
      );
      return;
    }
    cgi(req, res, match[1], match[2], url.search.replace(/^\?/, ""));
  });

  return {
    TOKEN,
    root,
    repos,
    state,
    addRepo,
    git,
    gitEnv,
    async listen() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${server.address().port}/`;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      server.closeAllConnections?.();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

module.exports = { createStub, TOKEN };
