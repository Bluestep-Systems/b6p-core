// Behavioral spec for the gateway git layer (`core.gateway.git`): pure-JS clone, fast-forward
// pull, status and push over the gateway's smart HTTP endpoints.
//
// What it pins: clone and fast-forward pull work against a real git smart-HTTP backend (git's own
// `git http-backend` mounted on FakeGateway); a pull that would overwrite local changes is refused
// with the paths and changes nothing; push is fast-forward only (never forced, never a deletion,
// never tags) and a non-fast-forward is a GatewayConflictError; every request carries the bearer
// token, which never reaches an error message or log line; a URL off the gateway's origin (or a
// redirect to one) never gets the token; file bytes (CRLF included) are never rewritten.
//
// Dependency-free node script (run via `npm test`). Exercises the COMPILED output in dist/. Needs
// `git` on PATH to build fixtures and serve them. All paths are built with node:path under
// os.tmpdir(), so it runs the same on Windows and POSIX.

const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { Err, FakeGateway, GatewayService, MockFileSystem } = require("../dist/index.js");
const { mountGitBackend, seedRepo, commitToRemote, git } = require("./support/GitHttpBackend");

// Prerequisite: fail loudly (never skip) when git is missing, before any case runs.
{
  const probe = require("node:child_process").spawnSync("git", ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    console.error(
      "GatewayGit spec FAILED: it needs `git` on PATH (to build fixtures and serve them with `git http-backend`), " +
        "but running `git --version` failed" +
        (probe.error ? `: ${probe.error.message}` : ` (exit ${probe.status})`) +
        ". Install git and re-run."
    );
    process.exit(1);
  }
}

const TOKEN = "b6pt_spec_gitgitgit0123456789";
const READ_ONLY_TOKEN = "b6pt_spec_readonly0123456789";

let failures = 0;
const pending = [];
function test(name, fn) {
  pending.push([name, fn]);
}

const logLines = [];
const thrownMessages = [];

function makeLogger() {
  const log = (...args) => logLines.push(args.map(String).join(" "));
  return { info: log, warn: log, error: log, debug: log };
}

const scratch = [];
function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b6p-gitspec-"));
  scratch.push(dir);
  return dir;
}

async function rejectsWith(promise, type) {
  try {
    await promise;
  } catch (error) {
    thrownMessages.push(error.message);
    assert.ok(error instanceof type, `expected ${type.name}, got ${error && error.name}: ${error && error.message}`);
    return error;
  }
  assert.fail(`expected ${type.name}, but it resolved`);
}

/** A fake gateway with a git backend and a repo `knowledge-base/kb-demo` seeded with a few files. */
async function withGit(fn, opts = {}) {
  const fake = await FakeGateway.start();
  fake.grantToken(TOKEN, ["kb:read", "kb:push"]);
  fake.grantToken(READ_ONLY_TOKEN, ["kb:read"]);
  const backend = mountGitBackend(fake, new Set([TOKEN]));
  const bare = seedRepo(backend, "knowledge-base", "kb-demo", {
    "a.txt": "alpha\n",
    "b.txt": "bravo\n",
    "dir/c.txt": "charlie\n",
    "crlf.txt": Buffer.from("one\r\ntwo\r\n"),
  });
  const service = new GatewayService(
    {
      fs: new MockFileSystem(),
      sessionManager: null,
      logger: makeLogger(),
      prompt: null,
      progress: null,
      isDebugMode: () => false,
      gatewayToken: { token: async () => ("token" in opts ? opts.token : TOKEN) },
      gatewayUrl: async () => fake.url,
      fetchFn: opts.fetchFn ?? globalThis.fetch.bind(globalThis),
    },
    opts.gitOptions ? { git: opts.gitOptions } : undefined
  );
  try {
    await fn({ fake, backend, bare, service, gitUrl: fake.gitUrl("knowledge-base", "kb-demo") });
  } finally {
    await fake.stop();
    backend.cleanup();
  }
}

const read = (...p) => fs.readFileSync(path.join(...p), "utf8");
const headOf = (dir) => git(dir, "rev-parse", "HEAD");

/** Clone into a fresh folder and return its path. */
async function cloned(ctx) {
  const dir = path.join(tmp(), "clone");
  await ctx.service.git.clone(ctx.gitUrl, dir);
  return dir;
}

// ── clone ───────────────────────────────────────────────────────────────

test("clone checks out the default branch with the files exactly as stored (CRLF kept)", async () => {
  await withGit(async (ctx) => {
    const dir = path.join(tmp(), "nested", "clone");
    const result = await ctx.service.git.clone(ctx.gitUrl, dir);
    assert.strictEqual(result.branch, "master");
    assert.strictEqual(result.head, git(ctx.bare, "rev-parse", "master"));
    assert.strictEqual(read(dir, "a.txt"), "alpha\n");
    assert.strictEqual(read(dir, "dir", "c.txt"), "charlie\n");
    assert.deepStrictEqual([...fs.readFileSync(path.join(dir, "crlf.txt"))], [...Buffer.from("one\r\ntwo\r\n")]);
    // real git agrees the clone is complete and clean
    assert.strictEqual(git(dir, "status", "--porcelain"), "");
    assert.strictEqual(git(dir, "config", "branch.master.remote"), "origin");
  });
});

test("every request carries the bearer token, and nothing else is sent anywhere", async () => {
  await withGit(async (ctx) => {
    await cloned(ctx);
    assert.ok(ctx.fake.requests.length >= 2);
    for (const r of ctx.fake.requests) {
      assert.strictEqual(r.authorization, `Bearer ${TOKEN}`, `${r.method} ${r.path}`);
      assert.ok(r.path.startsWith("/api/v1/git/knowledge-base/kb-demo.git/"), r.path);
    }
  });
});

test("clone of a named branch and of a tag", async () => {
  await withGit(async (ctx) => {
    commitToRemote(ctx.bare, "dev", { "dev.txt": "dev\n" });
    git(ctx.bare, "tag", "v1", "master");
    const onDev = path.join(tmp(), "dev");
    const result = await ctx.service.git.clone(ctx.gitUrl, onDev, { ref: "dev" });
    assert.strictEqual(result.branch, "dev");
    assert.strictEqual(read(onDev, "dev.txt"), "dev\n");

    const onTag = path.join(tmp(), "tag");
    const tagged = await ctx.service.git.clone(ctx.gitUrl, onTag, { ref: "v1" });
    assert.strictEqual(tagged.head, git(ctx.bare, "rev-parse", "v1"));
    assert.ok(!fs.existsSync(path.join(onTag, "dev.txt")));
  });
});

test("clone of a ref the repository lacks is ref-not-found and leaves no folder behind", async () => {
  await withGit(async (ctx) => {
    const dir = path.join(tmp(), "none");
    const error = await rejectsWith(
      ctx.service.git.clone(ctx.gitUrl, dir, { ref: "nope" }),
      Err.GatewayWorkingCopyError
    );
    assert.strictEqual(error.reason, "ref-not-found");
    assert.ok(!fs.existsSync(dir));
  });
});

test("clone into a folder that has files is refused and touches nothing", async () => {
  await withGit(async (ctx) => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "mine.txt"), "mine");
    const error = await rejectsWith(ctx.service.git.clone(ctx.gitUrl, dir), Err.GatewayWorkingCopyError);
    assert.strictEqual(error.reason, "not-empty");
    assert.deepStrictEqual(fs.readdirSync(dir), ["mine.txt"]);
    assert.strictEqual(ctx.fake.requests.length, 0);
  });
});

test("clone into an existing empty folder works", async () => {
  await withGit(async (ctx) => {
    const dir = tmp();
    await ctx.service.git.clone(ctx.gitUrl, dir);
    assert.strictEqual(read(dir, "a.txt"), "alpha\n");
  });
});

test("clone maps gateway failures to typed errors and leaves nothing behind", async () => {
  await withGit(async (ctx) => {
    const missing = path.join(tmp(), "x");
    const notFound = await rejectsWith(
      ctx.service.git.clone(ctx.fake.gitUrl("knowledge-base", "kb-absent"), missing),
      Err.GatewayError
    );
    assert.ok(notFound instanceof Err.GatewayError);
    assert.ok(!fs.existsSync(missing));
  });
  await withGit(
    async (ctx) => {
      const dir = path.join(tmp(), "x");
      const error = await rejectsWith(ctx.service.git.clone(ctx.gitUrl, dir), Err.GatewayAuthError);
      assert.strictEqual(error.reason, "token-missing");
      assert.strictEqual(ctx.fake.requests.length, 0);
    },
    { token: undefined }
  );
  await withGit(async (ctx) => {
    ctx.fake.revokeToken(TOKEN);
    const dir = path.join(tmp(), "x");
    const error = await rejectsWith(ctx.service.git.clone(ctx.gitUrl, dir), Err.GatewayAuthError);
    assert.strictEqual(error.reason, "token-invalid");
    assert.strictEqual(error.status, 401);
    assert.ok(!fs.existsSync(dir));
  });
  await withGit(async (ctx) => {
    ctx.fake.failNext({ status: 502, body: { error: "forge-unavailable", message: "down" } });
    await rejectsWith(ctx.service.git.clone(ctx.gitUrl, path.join(tmp(), "x")), Err.GatewayUnavailableError);
  });
});

test("an error body that echoes the token is redacted", async () => {
  await withGit(async (ctx) => {
    ctx.fake.failNext({ status: 401, body: { error: "token-invalid", message: `bad ${TOKEN} here` } });
    const error = await rejectsWith(ctx.service.git.clone(ctx.gitUrl, path.join(tmp(), "x")), Err.GatewayAuthError);
    assert.ok(!error.message.includes(TOKEN));
    assert.ok(error.message.includes("b6pt_…"));
  });
});

// ── foreign origins ─────────────────────────────────────────────────────

async function withForeignServer(fn) {
  let hits = 0;
  const seen = [];
  const server = http.createServer((req, res) => {
    hits++;
    seen.push(req.headers.authorization);
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`, () => ({ hits, seen }));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("a git URL off the gateway's origin is refused before anything is sent", async () => {
  await withGit(async (ctx) => {
    await withForeignServer(async (foreign, stats) => {
      const dir = path.join(tmp(), "x");
      await rejectsWith(
        ctx.service.git.clone(`${foreign}/api/v1/git/knowledge-base/kb-demo.git`, dir),
        Err.GatewayConfigError
      );
      assert.ok(!fs.existsSync(dir));
      assert.strictEqual(stats().hits, 0);
      assert.strictEqual(ctx.fake.requests.length, 0);
    });
  });
});

test("a redirect to another origin is not followed, so the token never reaches it", async () => {
  await withForeignServer(async (foreign, stats) => {
    const fake = await FakeGateway.start();
    fake.grantToken(TOKEN, ["kb:read"]);
    fake.route({
      method: "GET",
      prefix: "/api/v1/git/",
      handler: (req, res) => {
        res.writeHead(302, { Location: `${foreign}/stolen` }).end();
      },
    });
    const service = new GatewayService({
      fs: new MockFileSystem(),
      sessionManager: null,
      logger: makeLogger(),
      prompt: null,
      progress: null,
      isDebugMode: () => false,
      gatewayToken: { token: async () => TOKEN },
      gatewayUrl: async () => fake.url,
      fetchFn: globalThis.fetch.bind(globalThis),
    });
    try {
      const dir = path.join(tmp(), "x");
      const error = await rejectsWith(
        service.git.clone(fake.gitUrl("knowledge-base", "kb-moved"), dir),
        Err.GatewayUnexpectedResponseError
      );
      assert.strictEqual(error.code, "redirect-refused");
      assert.strictEqual(error.status, 302);
      assert.ok(!error.message.includes(foreign), "the server-supplied Location is not quoted");
      assert.strictEqual(stats().hits, 0);
      assert.ok(!fs.existsSync(dir));
    } finally {
      await fake.stop();
    }
  });
});

test("a response whose URL is off the gateway's origin is discarded", async () => {
  const real = globalThis.fetch.bind(globalThis);
  const fetchFn = async (url, init) => {
    const response = await real(url, init);
    Object.defineProperty(response, "url", { value: "http://127.0.0.1:1/elsewhere" });
    return response;
  };
  await withGit(
    async (ctx) => {
      const dir = path.join(tmp(), "x");
      await rejectsWith(ctx.service.git.clone(ctx.gitUrl, dir), Err.GatewayConfigError);
      assert.ok(!fs.existsSync(dir));
    },
    { fetchFn }
  );
});

// ── status ──────────────────────────────────────────────────────────────

test("status: clean, dirty, ahead and behind", async () => {
  await withGit(async (ctx) => {
    const dir = await cloned(ctx);
    let status = await ctx.service.git.status(dir);
    assert.strictEqual(status.branch, "master");
    assert.strictEqual(status.upstream, "origin/master");
    assert.strictEqual(status.head, headOf(dir));
    assert.deepStrictEqual([status.dirty, status.dirtyPaths, status.ahead, status.behind], [false, [], 0, 0]);

    fs.writeFileSync(path.join(dir, "a.txt"), "changed\n");
    fs.writeFileSync(path.join(dir, "new.txt"), "new\n");
    status = await ctx.service.git.status(dir);
    assert.strictEqual(status.dirty, true);
    assert.deepStrictEqual(status.dirtyPaths, ["a.txt", "new.txt"]);

    git(dir, "checkout", "--", "a.txt");
    fs.rmSync(path.join(dir, "new.txt"));
    git(dir, "commit", "--allow-empty", "-m", "local");
    commitToRemote(ctx.bare, "master", { "r.txt": "r\n" });
    // without fetch, status knows only what is on disk
    status = await ctx.service.git.status(dir);
    assert.deepStrictEqual([status.ahead, status.behind], [1, 0]);
    status = await ctx.service.git.status(dir, { fetch: true });
    assert.deepStrictEqual([status.ahead, status.behind], [1, 1]);
  });
});

test("status of a folder that is not a clone", async () => {
  await withGit(async (ctx) => {
    const error = await rejectsWith(ctx.service.git.status(tmp()), Err.GatewayWorkingCopyError);
    assert.strictEqual(error.reason, "not-a-clone");
  });
});

// ── pull ────────────────────────────────────────────────────────────────

test("pull fast-forwards a clean clone with no prompt, including adds, edits and deletes", async () => {
  await withGit(async (ctx) => {
    const dir = await cloned(ctx);
    const before = headOf(dir);
    const unchanged = await ctx.service.git.pull(dir);
    assert.strictEqual(unchanged.outcome, "up-to-date");

    const remoteHead = commitToRemote(ctx.bare, "master", { "a.txt": "alpha 2\n", "added/n.txt": "n\n" });
    const result = await ctx.service.git.pull(dir);
    assert.deepStrictEqual(
      [result.outcome, result.branch, result.from, result.to],
      ["fast-forwarded", "master", before, remoteHead]
    );
    assert.strictEqual(headOf(dir), remoteHead);
    assert.strictEqual(read(dir, "a.txt"), "alpha 2\n");
    assert.strictEqual(read(dir, "added", "n.txt"), "n\n");
    assert.strictEqual(git(dir, "status", "--porcelain"), "");
    assert.deepStrictEqual([...fs.readFileSync(path.join(dir, "crlf.txt"))], [...Buffer.from("one\r\ntwo\r\n")]);
  });
});

test("pull keeps local changes the incoming commits do not touch", async () => {
  await withGit(async (ctx) => {
    const dir = await cloned(ctx);
    fs.writeFileSync(path.join(dir, "b.txt"), "my edit\n");
    fs.writeFileSync(path.join(dir, "mine.txt"), "untracked\n");
    const remoteHead = commitToRemote(ctx.bare, "master", { "a.txt": "alpha 2\n" });
    const result = await ctx.service.git.pull(dir);
    assert.strictEqual(result.outcome, "fast-forwarded");
    assert.strictEqual(headOf(dir), remoteHead);
    assert.strictEqual(read(dir, "a.txt"), "alpha 2\n");
    assert.strictEqual(read(dir, "b.txt"), "my edit\n");
    assert.strictEqual(read(dir, "mine.txt"), "untracked\n");
  });
});

test("pull over local changes to a file the incoming commits change is refused, naming the paths, changing nothing", async () => {
  await withGit(async (ctx) => {
    const dir = await cloned(ctx);
    const before = headOf(dir);
    fs.writeFileSync(path.join(dir, "a.txt"), "my edit\n");
    fs.writeFileSync(path.join(dir, "taken.txt"), "my untracked\n");
    commitToRemote(ctx.bare, "master", { "a.txt": "alpha 2\n", "taken.txt": "theirs\n", "other.txt": "o\n" });
    const error = await rejectsWith(ctx.service.git.pull(dir), Err.GatewayDirtyWorkingTreeError);
    assert.deepStrictEqual(error.paths, ["a.txt", "taken.txt"]);
    assert.ok(!error.message.includes("--"), "no flags in core's messages");
    assert.strictEqual(headOf(dir), before);
    assert.strictEqual(read(dir, "a.txt"), "my edit\n");
    assert.strictEqual(read(dir, "taken.txt"), "my untracked\n");
    assert.ok(!fs.existsSync(path.join(dir, "other.txt")), "the working tree was not touched at all");
  });
});

test("a staged or deleted file the incoming commits change is refused too", async () => {
  await withGit(async (ctx) => {
    const dir = await cloned(ctx);
    fs.rmSync(path.join(dir, "b.txt"));
    fs.writeFileSync(path.join(dir, "dir", "c.txt"), "staged\n");
    git(dir, "add", "dir/c.txt");
    commitToRemote(ctx.bare, "master", { "b.txt": "bravo 2\n", "dir/c.txt": "charlie 2\n" });
    const error = await rejectsWith(ctx.service.git.pull(dir), Err.GatewayDirtyWorkingTreeError);
    assert.deepStrictEqual(error.paths, ["b.txt", "dir/c.txt"]);
  });
});

test("pull when both sides have moved on is diverged, and changes nothing", async () => {
  await withGit(async (ctx) => {
    const dir = await cloned(ctx);
    git(dir, "commit", "--allow-empty", "-m", "local");
    const local = headOf(dir);
    commitToRemote(ctx.bare, "master", { "r.txt": "r\n" });
    const error = await rejectsWith(ctx.service.git.pull(dir), Err.GatewayWorkingCopyError);
    assert.strictEqual(error.reason, "diverged");
    assert.strictEqual(headOf(dir), local);
    assert.ok(!fs.existsSync(path.join(dir, "r.txt")));
  });
});

test("pull with only local commits is ahead, with nothing to pull", async () => {
  await withGit(async (ctx) => {
    const dir = await cloned(ctx);
    git(dir, "commit", "--allow-empty", "-m", "local");
    const local = headOf(dir);
    const result = await ctx.service.git.pull(dir);
    assert.deepStrictEqual([result.outcome, result.to], ["ahead", local]);
  });
});

test("pull on a detached head, a branch with no upstream and a non-clone are typed", async () => {
  await withGit(async (ctx) => {
    const dir = await cloned(ctx);
    git(dir, "checkout", "-q", "-b", "local-only");
    let error = await rejectsWith(ctx.service.git.pull(dir), Err.GatewayWorkingCopyError);
    assert.strictEqual(error.reason, "no-upstream");
    git(dir, "checkout", "-q", "--detach");
    error = await rejectsWith(ctx.service.git.pull(dir), Err.GatewayWorkingCopyError);
    assert.strictEqual(error.reason, "detached");
    error = await rejectsWith(ctx.service.git.pull(tmp()), Err.GatewayWorkingCopyError);
    assert.strictEqual(error.reason, "not-a-clone");
  });
});

// ── push ────────────────────────────────────────────────────────────────

test("push sends the current branch as a fast-forward", async () => {
  await withGit(async (ctx) => {
    const dir = await cloned(ctx);
    fs.writeFileSync(path.join(dir, "a.txt"), "alpha 3\n");
    git(dir, "commit", "-a", "-m", "edit");
    const head = headOf(dir);
    const result = await ctx.service.git.push(dir);
    assert.deepStrictEqual(
      [result.pushed, result.branch, result.remoteBranch, result.head],
      [true, "master", "master", head]
    );
    assert.strictEqual(git(ctx.bare, "rev-parse", "master"), head);
    const status = await ctx.service.git.status(dir);
    assert.deepStrictEqual([status.ahead, status.behind], [0, 0]);
    const posts = ctx.fake.requests.filter((r) => r.method === "POST" && r.path.endsWith("git-receive-pack"));
    assert.strictEqual(posts.length, 1);
    assert.strictEqual(posts[0].authorization, `Bearer ${TOKEN}`);
  });
});

test("push with nothing ahead sends nothing", async () => {
  await withGit(async (ctx) => {
    const dir = await cloned(ctx);
    const result = await ctx.service.git.push(dir);
    assert.strictEqual(result.pushed, false);
    assert.ok(!ctx.fake.requests.some((r) => r.path.endsWith("git-receive-pack")));
  });
});

test("push when the upstream has moved on is a GatewayConflictError and never reaches the wire", async () => {
  await withGit(async (ctx) => {
    const dir = await cloned(ctx);
    git(dir, "commit", "--allow-empty", "-m", "local");
    const remoteHead = commitToRemote(ctx.bare, "master", { "r.txt": "r\n" });
    const error = await rejectsWith(ctx.service.git.push(dir), Err.GatewayConflictError);
    assert.strictEqual(error.status, 409);
    assert.strictEqual(git(ctx.bare, "rev-parse", "master"), remoteHead);
    assert.ok(!ctx.fake.requests.some((r) => r.method === "POST" && r.path.endsWith("git-receive-pack")));
  });
});

test("a 409 from the gateway on push is a GatewayConflictError too", async () => {
  await withGit(async (ctx) => {
    const dir = await cloned(ctx);
    git(dir, "commit", "--allow-empty", "-m", "local");
    ctx.backend.rejectPushWith409 = true;
    const before = git(ctx.bare, "rev-parse", "master");
    await rejectsWith(ctx.service.git.push(dir), Err.GatewayConflictError);
    assert.strictEqual(git(ctx.bare, "rev-parse", "master"), before);
  });
});

test("push never sends tags or other branches", async () => {
  await withGit(async (ctx) => {
    const dir = await cloned(ctx);
    git(dir, "commit", "--allow-empty", "-m", "local");
    git(dir, "tag", "local-tag");
    git(dir, "branch", "side");
    await ctx.service.git.push(dir);
    assert.strictEqual(git(ctx.bare, "tag", "--list"), "");
    assert.strictEqual(git(ctx.bare, "branch", "--list", "side"), "");
  });
});

test("push without the push scope is GatewayScopeError", async () => {
  await withGit(
    async (ctx) => {
      const dir = await cloned(ctx);
      git(dir, "commit", "--allow-empty", "-m", "local");
      const before = git(ctx.bare, "rev-parse", "master");
      const error = await rejectsWith(ctx.service.git.push(dir), Err.GatewayScopeError);
      assert.strictEqual(error.scope, "kb:push");
      assert.strictEqual(git(ctx.bare, "rev-parse", "master"), before);
    },
    { token: READ_ONLY_TOKEN }
  );
});

test("push on a branch without an upstream, a detached head and a non-clone are typed", async () => {
  await withGit(async (ctx) => {
    const dir = await cloned(ctx);
    git(dir, "checkout", "-q", "-b", "local-only");
    let error = await rejectsWith(ctx.service.git.push(dir), Err.GatewayWorkingCopyError);
    assert.strictEqual(error.reason, "no-upstream");
    git(dir, "checkout", "-q", "--detach");
    error = await rejectsWith(ctx.service.git.push(dir), Err.GatewayWorkingCopyError);
    assert.strictEqual(error.reason, "detached");
    error = await rejectsWith(ctx.service.git.push(tmp()), Err.GatewayWorkingCopyError);
    assert.strictEqual(error.reason, "not-a-clone");
  });
});

test("git operations run one at a time, in call order", async () => {
  await withGit(async (ctx) => {
    const dir = await cloned(ctx);
    ctx.fake.requests.length = 0;
    ctx.fake.maxInFlight = 0;
    commitToRemote(ctx.bare, "master", { "r.txt": "r\n" });
    await Promise.all([
      ctx.service.git.pull(dir),
      ctx.service.git.status(dir, { fetch: true }),
      ctx.service.git.push(dir),
    ]);
    assert.strictEqual(ctx.fake.maxInFlight, 1);
  });
});

// ── timeouts (a stalled gateway must never wedge the queue) ─────────────

const FAST = { firstByteTimeoutMs: 200, idleTimeoutMs: 200 };

test("a gateway that never answers a git request is GatewayUnavailableError, and the queue is released", async () => {
  let stall = true;
  const real = globalThis.fetch.bind(globalThis);
  // ignores the abort signal on purpose: the timeout must not depend on fetch honouring it
  const fetchFn = (url, init) => (stall ? new Promise(() => {}) : real(url, init));
  await withGit(
    async (ctx) => {
      const dir = path.join(tmp(), "x");
      const started = Date.now();
      const error = await rejectsWith(ctx.service.git.clone(ctx.gitUrl, dir), Err.GatewayUnavailableError);
      assert.ok(Date.now() - started < 5_000);
      assert.ok(!fs.existsSync(dir));
      stall = false;
      const queued = await ctx.service.client.getJson("/api/v1/knowledge-bases");
      assert.deepStrictEqual(queued, { knowledgeBases: [] });
      assert.ok(error.message.length > 0);
    },
    { fetchFn, gitOptions: FAST }
  );
});

test("a git response that stalls mid-body is GatewayUnavailableError, and the queue is released", async () => {
  let stall = true;
  const real = globalThis.fetch.bind(globalThis);
  const fetchFn = (url, init) => {
    if (!stall) {
      return real(url, init);
    }
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("001e# service=git-upload-pack\n"));
      },
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  };
  await withGit(
    async (ctx) => {
      const dir = path.join(tmp(), "x");
      await rejectsWith(ctx.service.git.clone(ctx.gitUrl, dir), Err.GatewayUnavailableError);
      assert.ok(!fs.existsSync(dir));
      stall = false;
      await ctx.service.client.getJson("/api/v1/knowledge-bases");
    },
    { fetchFn, gitOptions: FAST }
  );
});

test("a slow but steady body is not cut off by the idle timeout", async () => {
  await withGit(
    async (ctx) => {
      const dir = await cloned(ctx);
      assert.strictEqual(read(dir, "a.txt"), "alpha\n");
    },
    { gitOptions: { firstByteTimeoutMs: 5_000, idleTimeoutMs: 5_000 } }
  );
});

// ── pull ordering ───────────────────────────────────────────────────────

test("pull checks the files out BEFORE it moves the branch, so a crash mid-checkout cannot leave HEAD ahead of the tree", async () => {
  const iso = require("isomorphic-git").default; // the object GatewayGit calls through
  await withGit(async (ctx) => {
    const dir = await cloned(ctx);
    const before = headOf(dir);
    commitToRemote(ctx.bare, "master", { "a.txt": "alpha 2\n" });
    const realCheckout = iso.checkout;
    let branchDuringCheckout;
    iso.checkout = async (args) => {
      branchDuringCheckout = git(dir, "rev-parse", "refs/heads/master");
      return realCheckout(args);
    };
    try {
      await ctx.service.git.pull(dir);
    } finally {
      iso.checkout = realCheckout;
    }
    assert.strictEqual(branchDuringCheckout, before, "the branch must not move until the checkout has succeeded");
    assert.strictEqual(read(dir, "a.txt"), "alpha 2\n");
    assert.strictEqual(git(dir, "status", "--porcelain"), "");
  });
});

test("a pull whose checkout fails leaves the branch where it was", async () => {
  const iso = require("isomorphic-git").default; // the object GatewayGit calls through
  await withGit(async (ctx) => {
    const dir = await cloned(ctx);
    const before = headOf(dir);
    commitToRemote(ctx.bare, "master", { "a.txt": "alpha 2\n" });
    const realCheckout = iso.checkout;
    iso.checkout = async () => {
      throw new Error("disk full");
    };
    try {
      await rejectsWith(ctx.service.git.pull(dir), Error);
    } finally {
      iso.checkout = realCheckout;
    }
    assert.strictEqual(headOf(dir), before);
  });
});

// ── Run ─────────────────────────────────────────────────────────────────

(async () => {
  for (const [name, fn] of pending) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (error) {
      failures++;
      console.error(`  ✗ ${name}\n    ${error && error.stack}`);
    }
  }

  const leaks = [...thrownMessages, ...logLines].filter((line) => line.includes(TOKEN));
  if (thrownMessages.length === 0 || leaks.length > 0) {
    failures++;
    console.error(`  ✗ the token never appears in a thrown message or log line\n    ${leaks.join("\n    ")}`);
  } else {
    console.log(
      `  ✓ the token never appears in a thrown message or log line (${thrownMessages.length} errors, ${logLines.length} log lines)`
    );
  }

  for (const dir of scratch) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (failures > 0) {
    console.error(`\nGatewayGit: ${failures} failing`);
    process.exit(1);
  }
  console.log(`\nGatewayGit: all ${pending.length + 1} passing`);
})();
