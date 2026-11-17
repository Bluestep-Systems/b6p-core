// A tiny in-test stand-in for the platform's git proxy (GitProxyController) and publish mutation.
//
// It serves real bare repos over smart HTTP by running `git http-backend` as a CGI behind node:http, and mimics the
// proxy's gates: Basic auth with a b6pt_ password (else 401 + challenge), 404 for an unknown repo, 403 with the
// gate's reason for a push to a WEBDAV-mode or code-locked script, and a pre-receive hook standing in for the forge's
// protected master. POST /gql with takeSnapshot fast-forwards master to draft the way publishFromGit does, and with
// compileDraft builds the draft branch at expectedDraftSha the way the platform's git build does: one build commit
// with a stand-in output per TypeScript source and, when the build is clean, the build manifest.
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

// The draft tree's build layout by contract v1 §1-§3: the tree (path -> blob oid), the output folder, the manifest's
// path, whether the draft needs a build at all, and its sources (path -> oid).
function layout(entry) {
  const tree = new Map(
    git(entry.bare, "ls-tree", "-r", "draft")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [meta, file] = line.split("\t");
        return [file, meta.split(" ")[2]];
      })
  );
  const show = (p) => git(entry.bare, "show", `draft:${p}`);
  const configPath = tree.has("tsconfig.json")
    ? "tsconfig.json"
    : tree.has("jsconfig.json")
      ? "jsconfig.json"
      : undefined;
  let declared;
  if (configPath) {
    try {
      const text = show(configPath)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/,(\s*[}\]])/g, "$1");
      const outDir = JSON.parse(text)?.compilerOptions?.outDir;
      declared = typeof outDir === "string" ? outDir : undefined;
    } catch {
      declared = undefined;
    }
  }
  let folder = declared === undefined ? ".build" : declared;
  if (folder.startsWith("./")) {
    folder = folder.slice(2);
  }
  if (
    folder === "" ||
    /^[/.]*$/.test(folder) ||
    folder.startsWith("/") ||
    folder.includes("\\") ||
    folder.split("/").includes("..")
  ) {
    folder = "";
  }
  folder = folder.replace(/\/+$/, "");
  const manifestPath = folder === "" ? ".b6p-build.json" : `${folder}/.b6p-build.json`;
  const outside = (p) => p !== manifestPath && (folder === "" || !p.startsWith(`${folder}/`));
  const tsSources = [...tree.keys()].filter((p) => {
    const name = p.split("/").pop();
    const dot = name.lastIndexOf(".");
    return (
      dot >= 0 &&
      ["ts", "tsx", "mts", "cts"].includes(name.slice(dot + 1).toLowerCase()) &&
      !name.slice(0, dot).toLowerCase().endsWith(".d") &&
      outside(p)
    );
  });
  const exts = new Set(["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "json", "jsonc"]);
  const sources = new Map();
  for (const [p, oid] of tree) {
    const name = p.split("/").pop();
    const dot = name.lastIndexOf(".");
    if (dot >= 0 && exts.has(name.slice(dot + 1).toLowerCase()) && outside(p)) {
      sources.set(p, oid);
    }
  }
  const hasTsconfig = [...tree.keys()].some((p) => p.split("/").pop() === "tsconfig.json");
  return { tree, show, folder, manifestPath, tsSources, sources, needsBuild: hasTsconfig && tsSources.length > 0 };
}

// The platform's git build of the draft (compileDraft with expectedDraftSha), standing in for the compiler: each
// TypeScript source gets `<outDir>/<path>.js`, output the build no longer writes is deleted, and the manifest is
// written only when the build is clean (`entry.buildUnclean` makes it unclean). One commit, authored as
// `entry.buildAuthor`; none when nothing changed. Returns { status, commit, vouched }.
// The platform's build trailer: the source sha a build commit was built from (the nearest non-build ancestor).
function buildSourceOf(bare, sha) {
  const body = git(bare, "log", "-1", "--format=%B", sha);
  const match = /^Bluestep-Build-Of: ([0-9a-f]{40})$/m.exec(body);
  return match ? match[1] : null;
}

function serverBuild(entry, root) {
  const draft = git(entry.bare, "rev-parse", "refs/heads/draft");
  if (entry.externallyBuilt) {
    return { status: "SKIPPED_EXTERNALLY_BUILT", commit: draft, vouched: true };
  }
  const plan = layout(entry);
  if (!plan.needsBuild) {
    return { status: "NOTHING_TO_COMPILE", commit: draft, vouched: true };
  }
  const work = fs.mkdtempSync(path.join(root, "build-"));
  try {
    git(root, "clone", "-q", "-b", "draft", entry.bare, work);
    const prefix = plan.folder === "" ? "" : `${plan.folder}/`;
    const emitted = new Set();
    for (const source of plan.tsSources) {
      const out = `${prefix}${source.replace(/\.[cm]?tsx?$/i, ".js")}`;
      emitted.add(out);
      fs.mkdirSync(path.dirname(path.join(work, out)), { recursive: true });
      fs.writeFileSync(path.join(work, out), `// built from ${source} ${plan.tree.get(source)}\n`);
    }
    for (const p of plan.tree.keys()) {
      if (prefix !== "" && p.startsWith(prefix) && p.endsWith(".js") && !emitted.has(p)) {
        fs.rmSync(path.join(work, p));
      }
    }
    const vouched = !entry.buildUnclean;
    if (!vouched && plan.tree.has(plan.manifestPath)) {
      // An unclean build deletes the manifest.
      fs.rmSync(path.join(work, plan.manifestPath));
    }
    if (vouched) {
      const sources = {};
      for (const p of [...plan.sources.keys()].sort()) {
        sources[p] = plan.sources.get(p);
      }
      fs.mkdirSync(path.dirname(path.join(work, plan.manifestPath)), { recursive: true });
      fs.writeFileSync(path.join(work, plan.manifestPath), JSON.stringify({ version: 1, builder: "stub", sources }));
    }
    // The platform commits its output whatever .gitignore says.
    git(work, "add", "-A", "-f");
    if (git(work, "status", "--porcelain") === "") {
      return { status: "COMPILED", commit: draft, vouched };
    }
    const who = entry.buildAuthor || { name: "Pushing User", email: "pusher@example.test" };
    gitEnv(
      work,
      {
        GIT_AUTHOR_NAME: who.name,
        GIT_AUTHOR_EMAIL: who.email,
        GIT_COMMITTER_NAME: who.name,
        GIT_COMMITTER_EMAIL: who.email,
      },
      "commit",
      "-q",
      "-m",
      "Build draft",
      "-m",
      `Bluestep-Build-Of: ${buildSourceOf(entry.bare, draft) ?? draft}`
    );
    git(work, "push", "-q", entry.bare, "draft");
    return { status: "COMPILED", commit: git(work, "rev-parse", "HEAD"), vouched };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// The server's build manifest check (contract v1 §5), written out independently of the client's implementation.
// Returns null when the publish may go on, else { reason, withheld }.
function buildCheck(entry) {
  if (entry.externallyBuilt) {
    return null;
  }
  const tree = new Map(
    git(entry.bare, "ls-tree", "-r", "draft")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [meta, file] = line.split("\t");
        return [file, meta.split(" ")[2]];
      })
  );
  if (![...tree.keys()].some((p) => p.split("/").pop() === "tsconfig.json")) {
    return null;
  }
  const show = (p) => git(entry.bare, "show", `draft:${p}`);
  const configPath = tree.has("tsconfig.json")
    ? "tsconfig.json"
    : tree.has("jsconfig.json")
      ? "jsconfig.json"
      : undefined;
  let declared;
  if (configPath) {
    try {
      const text = show(configPath)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/,(\s*[}\]])/g, "$1");
      const outDir = JSON.parse(text)?.compilerOptions?.outDir;
      declared = typeof outDir === "string" ? outDir : undefined;
    } catch {
      declared = undefined;
    }
  }
  let folder = declared === undefined ? ".build" : declared;
  if (folder.startsWith("./")) {
    folder = folder.slice(2);
  }
  if (
    folder === "" ||
    /^[/.]*$/.test(folder) ||
    folder.startsWith("/") ||
    folder.includes("\\") ||
    folder.split("/").includes("..")
  ) {
    folder = "";
  }
  folder = folder.replace(/\/+$/, "");
  const manifestPath = folder === "" ? ".b6p-build.json" : `${folder}/.b6p-build.json`;
  // No TypeScript source outside the output folder (a declaration does not count): nothing to build, so exempt.
  const tsSource = [...tree.keys()].some((p) => {
    const name = p.split("/").pop();
    const dot = name.lastIndexOf(".");
    return (
      dot >= 0 &&
      ["ts", "tsx", "mts", "cts"].includes(name.slice(dot + 1).toLowerCase()) &&
      !name.slice(0, dot).toLowerCase().endsWith(".d") &&
      p !== manifestPath &&
      (folder === "" || !p.startsWith(`${folder}/`))
    );
  });
  if (!tsSource) {
    return null;
  }
  if (!tree.has(manifestPath)) {
    return { reason: "BUILD_MANIFEST_MISSING", withheld: [manifestPath] };
  }
  let manifest;
  try {
    manifest = JSON.parse(show(manifestPath));
  } catch {
    return { reason: "BUILD_MANIFEST_INVALID", withheld: [manifestPath] };
  }
  const sourcesOk =
    manifest &&
    typeof manifest === "object" &&
    manifest.version === 1 &&
    manifest.sources &&
    typeof manifest.sources === "object" &&
    !Array.isArray(manifest.sources);
  if (!sourcesOk || !Object.values(manifest.sources).every((v) => typeof v === "string" && /^[0-9a-f]{40}$/.test(v))) {
    return { reason: "BUILD_MANIFEST_INVALID", withheld: [manifestPath] };
  }
  const exts = new Set(["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "json", "jsonc"]);
  const sources = new Map();
  for (const [p, oid] of tree) {
    const name = p.split("/").pop();
    const dot = name.lastIndexOf(".");
    if (
      dot >= 0 &&
      exts.has(name.slice(dot + 1).toLowerCase()) &&
      p !== manifestPath &&
      (folder === "" || !p.startsWith(`${folder}/`))
    ) {
      sources.set(p, oid);
    }
  }
  const stale = new Set();
  for (const [p, oid] of Object.entries(manifest.sources)) {
    if (sources.get(p) !== oid) {
      stale.add(p);
    }
  }
  for (const p of sources.keys()) {
    if (!(p in manifest.sources)) {
      stale.add(p);
    }
  }
  return stale.size > 0 ? { reason: "BUILD_STALE", withheld: [...stale].sort() } : null;
}
/** Creates the temp area, a bare repo `<classid>___<seqnum>` seeded with one commit on master and draft. */
function createStub() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bsjs-git-stub-"));
  const repos = new Map(); // name -> { mode, locked, refusePublish }
  const backend = httpBackendPath();

  function addRepo(
    name,
    { mode = "GIT", locked = false, hidden = false, files = { "main.ts": "export const v = 1;\n" } } = {}
  ) {
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
      fs.mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
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
    repos.set(name, { mode, locked, hidden, refusePublish: undefined, bare });
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
      // git-http-backend may exit before it reads the body (an early refusal); its response still
      // arrives on stdout, so a broken stdin pipe is not the request's failure.
      child.stdin.on("error", () => {});
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
    publishInputs: [],
    buildInputs: [],
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
      if (input.compileDraft === true) {
        state.buildInputs.push(input);
        entry.beforeBuild?.();
        const queued = entry.buildQueue?.shift();
        const draft = git(entry.bare, "rev-parse", "refs/heads/draft");
        // The platform's DRAFT_MOVED rule: the head must be the commit asked for, or a build (or rebuild chain) whose
        // trailer names it (a repeat call after a build whose answer was lost).
        const isBuildOf = () => {
          if (draft === input.expectedDraftSha) {
            return true;
          }
          return buildSourceOf(entry.bare, draft) === input.expectedDraftSha;
        };
        if (input.expectedDraftSha !== undefined && !isBuildOf()) {
          res.end(
            JSON.stringify({
              errors: [
                {
                  message: "The draft changed after it was pushed",
                  extensions: {
                    code: "PRECONDITION",
                    reason: "DRAFT_MOVED",
                    publish: { expected: input.expectedDraftSha, actual: draft },
                  },
                },
              ],
            })
          );
          return;
        }
        if (typeof queued === "string" && queued.startsWith("REFUSE:")) {
          // A refusal before anything is built: DRAFT_TOO_LARGE, REPO_MISSING, DRAFT_BRANCH_MISSING, or a newer one.
          res.end(
            JSON.stringify({
              errors: [
                {
                  message: `Build refused: ${queued.slice(7)}`,
                  extensions: { code: "PRECONDITION", reason: queued.slice(7) },
                },
              ],
            })
          );
          return;
        }
        if (queued === "OUTCOME_UNKNOWN" || queued === "OUTCOME_UNKNOWN_BUILT") {
          // The platform could not confirm its build push: it may (BUILT) or may not have landed.
          if (queued === "OUTCOME_UNKNOWN_BUILT") {
            serverBuild(entry, root);
          }
          res.end(
            JSON.stringify({
              errors: [
                {
                  message: "The build's outcome is not known",
                  extensions: { code: "PRECONDITION", reason: "BUILD_OUTCOME_UNKNOWN" },
                },
              ],
            })
          );
          return;
        }
        if (queued === "BUILD_THEN_NETWORK" || queued === "BUILD_THEN_BUSY") {
          // The platform built and committed, then the answer was lost (a 503 from the ingress) or said BUSY.
          serverBuild(entry, root);
          if (queued === "BUILD_THEN_NETWORK") {
            res.writeHead(503);
            res.end("{}");
          } else {
            res.end(
              JSON.stringify({
                data: { [mutation]: [{ id: input.topId }] },
                extensions: { bluestepCompile: [{ status: "BUSY", diagnostics: [] }] },
              })
            );
          }
          return;
        }
        if (queued === "NETWORK") {
          res.writeHead(503);
          res.end("{}");
          return;
        }
        if (queued === "GRAPHQL_ERROR") {
          res.end(JSON.stringify({ errors: [{ message: "You may not edit this script" }] }));
          return;
        }
        if (queued) {
          res.end(
            JSON.stringify({
              data: { [mutation]: [{ id: input.topId }] },
              extensions: { bluestepCompile: [{ status: queued, diagnostics: [] }] },
            })
          );
          return;
        }
        const built = serverBuild(entry, root);
        const diagnostics = entry.buildDiagnostics || [];
        const count = (severity) => diagnostics.filter((d) => d.severity === severity).length;
        res.end(
          JSON.stringify({
            data: { [mutation]: [{ id: input.topId }] },
            extensions: {
              bluestepCompile: [
                {
                  status: built.status,
                  errors: entry.buildCounts?.errors ?? count("ERROR"),
                  warnings: entry.buildCounts?.warnings ?? count("WARNING"),
                  written: 0,
                  deleted: 0,
                  diagnostics,
                  diagnosticsOmitted: entry.buildCounts?.omitted ?? 0,
                },
              ],
              // The platform's shape (web CU-1k5g91bq6u2): `built` says a build commit was made.
              bluestepBuild: [
                {
                  script: input.topId,
                  draftSha: input.expectedDraftSha ?? null,
                  commit: built.commit,
                  built: built.commit !== input.expectedDraftSha,
                  vouched: built.vouched,
                  status: built.status,
                },
              ],
            },
          })
        );
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
      // A test hook: someone else pushes between this client's verification and the publish.
      entry.beforePublish?.();
      const draft = git(entry.bare, "rev-parse", "refs/heads/draft");
      // The contract: a publish names the draft commit the caller verified; a draft that moved since is refused.
      state.publishInputs.push(input);
      if (input.expectedDraftSha !== undefined && !/^[0-9a-f]{40}$/.test(input.expectedDraftSha)) {
        // The server treats anything but a full commit id as bad input.
        res.end(
          JSON.stringify({
            errors: [
              { message: "expectedDraftSha must be a full 40-hex commit id", extensions: { code: "BAD_USER_INPUT" } },
            ],
          })
        );
        return;
      }
      if (input.expectedDraftSha !== undefined && input.expectedDraftSha !== draft) {
        res.end(
          JSON.stringify({
            errors: [
              {
                message: "The draft changed after it was checked",
                extensions: {
                  code: "PUBLISH_REFUSED",
                  reason: "DRAFT_MOVED",
                  publish: { expected: input.expectedDraftSha, actual: draft },
                },
              },
            ],
          })
        );
        return;
      }
      const build = buildCheck(entry);
      if (build) {
        res.end(
          JSON.stringify({
            errors: [
              {
                message: `The script was not published: `,
                extensions: { code: "PUBLISH_REFUSED", reason: build.reason, publish: { withheld: build.withheld } },
              },
            ],
          })
        );
        return;
      }
      if (entry.garblePublish) {
        res.end("<html>not json</html>");
        return;
      }
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
    // `hidden`: a script that publishes over WebDAV has no repo until git is switched on.
    if (!entry || (entry.hidden && entry.mode !== "GIT")) {
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
