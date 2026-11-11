// Behavioral spec for the knowledge-base layer (`core.gateway.kb`): list with filters and shape
// validation, resolving a global or tenant address, pull (clone, fast-forward, wrong repository,
// local changes in the way) and push (ok, not permitted, non-fast-forward).
//
// Dependency-free node script (run via `npm test`). Exercises the COMPILED output in dist/ against
// FakeGateway with git's own http-backend mounted (needs `git` on PATH). Paths are built with
// node:path under os.tmpdir(), so it runs the same on Windows and POSIX.

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Err, FakeGateway, GatewayService, MockFileSystem } = require("../dist/index.js");
const { mountGitBackend, seedRepo, commitToRemote, git } = require("./support/GitHttpBackend");

const TOKEN = "b6pt_spec_kbkbkbkb0123456789";

let failures = 0;
const pending = [];
function test(name, fn) {
  pending.push([name, fn]);
}

const logLines = [];
const thrownMessages = [];
const log = (...args) => logLines.push(args.map(String).join(" "));
const logger = { info: log, warn: log, error: log, debug: log };

const scratch = [];
function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b6p-kbspec-"));
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

function entry(fake, overrides) {
  const name = overrides.name;
  const tenant = overrides.tenant ?? null;
  const org = tenant ? `${tenant}-system` : "knowledge-base";
  return {
    ref: tenant ? `tenant/${tenant}/${name}` : `global/${name}`,
    scope: tenant ? "tenant" : "global",
    tenant,
    name,
    title: name.toUpperCase(),
    liveBranch: "master",
    canPush: true,
    gitUrl: fake.gitUrl(org, `kb-${name}`),
    ...overrides,
  };
}

/** A fake gateway holding global KB `demo`, global `other`, and tenant KB `U1/handbook`, all backed by real repos. */
async function withKb(fn) {
  const fake = await FakeGateway.start();
  fake.grantToken(TOKEN, ["kb:read", "kb:push"]);
  const backend = mountGitBackend(fake, new Set([TOKEN]));
  const demo = seedRepo(backend, "knowledge-base", "kb-demo", { "a.txt": "alpha\n", "dir/b.txt": "bravo\n" });
  seedRepo(backend, "knowledge-base", "kb-other", { "o.txt": "other\n" });
  const handbook = seedRepo(backend, "U1-system", "kb-handbook", { "h.txt": "hand\n" });
  fake.knowledgeBases = [
    entry(fake, { name: "demo" }),
    entry(fake, { name: "other", canPush: false }),
    entry(fake, { name: "handbook", tenant: "U1" }),
    entry(fake, { name: "demo", tenant: "U2" }),
  ];
  const service = new GatewayService({
    fs: new MockFileSystem(),
    sessionManager: null,
    logger,
    prompt: null,
    progress: null,
    isDebugMode: () => false,
    gatewayToken: { token: async () => TOKEN },
    gatewayUrl: async () => fake.url,
    fetchFn: globalThis.fetch.bind(globalThis),
  });
  try {
    await fn({ fake, backend, service, kb: service.kb, demo, handbook });
  } finally {
    await fake.stop();
    backend.cleanup();
  }
}

/** A fake gateway that answers the list route with whatever `body` is (no git). */
async function withBody(body, fn) {
  const fake = await FakeGateway.start();
  fake.grantToken(TOKEN, ["kb:read"]);
  fake.route({
    method: "GET",
    prefix: "/api/v1/knowledge-bases",
    scope: "kb:read",
    handler: (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    },
  });
  const service = new GatewayService({
    fs: new MockFileSystem(),
    sessionManager: null,
    logger,
    prompt: null,
    progress: null,
    isDebugMode: () => false,
    gatewayToken: { token: async () => TOKEN },
    gatewayUrl: async () => fake.url,
    fetchFn: globalThis.fetch.bind(globalThis),
  });
  try {
    await fn(service.kb, fake);
  } finally {
    await fake.stop();
  }
}

const read = (...p) => fs.readFileSync(path.join(...p), "utf8");

// ── list ────────────────────────────────────────────────────────────────

test("list returns typed entries and sends the scope and tenant filters", async () => {
  await withKb(async ({ fake, kb }) => {
    const all = await kb.list();
    assert.strictEqual(all.length, 4);
    assert.deepStrictEqual(
      Object.keys(all[0]).sort(),
      ["canPush", "gitUrl", "liveBranch", "name", "ref", "scope", "tenant", "title"]
    );
    assert.strictEqual(all[0].ref, "global/demo");
    assert.strictEqual(all[1].canPush, false);

    assert.deepStrictEqual((await kb.list({ scope: "global" })).map((k) => k.ref), ["global/demo", "global/other"]);
    assert.deepStrictEqual((await kb.list({ tenant: "U1" })).map((k) => k.ref), ["tenant/U1/handbook"]);
    assert.deepStrictEqual((await kb.list({ scope: "tenant", tenant: "U2" })).map((k) => k.ref), ["tenant/U2/demo"]);
    const last = fake.requests[fake.requests.length - 1];
    assert.deepStrictEqual(last.query, { scope: "tenant", tenant: "U2" });
    assert.strictEqual(last.authorization, `Bearer ${TOKEN}`);
  });
});

test("list refuses a body that is not the promised shape", async () => {
  const good = { ref: "global/a", scope: "global", tenant: null, name: "a", title: "A", liveBranch: "master", canPush: true, gitUrl: "http://x/a.git" };
  const cases = [
    "not json",
    [],
    {},
    { knowledgeBases: {} },
    { knowledgeBases: [null] },
    { knowledgeBases: [{ ...good, name: 7 }] },
    { knowledgeBases: [{ ...good, scope: "planet" }] },
    { knowledgeBases: [{ ...good, canPush: "yes" }] },
    { knowledgeBases: [{ ...good, tenant: "U1" }] },
    { knowledgeBases: [{ ...good, scope: "tenant", tenant: null }] },
    { knowledgeBases: [{ ...good, gitUrl: undefined }] },
    { knowledgeBases: [{ ...good, title: "" }] },
  ];
  for (const body of cases) {
    await withBody(body, async (kb) => {
      await rejectsWith(kb.list(), Err.GatewayUnexpectedResponseError);
    });
  }
  await withBody({ knowledgeBases: [good] }, async (kb) => {
    assert.strictEqual((await kb.list()).length, 1);
  });
});

test("list: an unknown or invisible tenant is an empty list, not an error; global rows have a null tenant; the server's order is kept", async () => {
  await withKb(async ({ kb }) => {
    assert.deepStrictEqual(await kb.list({ tenant: "U999" }), []);
    assert.deepStrictEqual(await kb.list({ scope: "tenant", tenant: "U999" }), []);
    assert.strictEqual((await kb.list({ scope: "global" })).every((k) => k.tenant === null), true);
  });
  const row = (name, tenant) => ({
    ref: tenant ? `tenant/${tenant}/${name}` : `global/${name}`,
    scope: tenant ? "tenant" : "global",
    tenant: tenant ?? null,
    name,
    title: name,
    liveBranch: "master",
    canPush: false,
    gitUrl: `http://x/${name}.git`,
  });
  const served = [row("zeta"), row("alpha"), row("b", "U9"), row("a", "U2")];
  await withBody({ knowledgeBases: served }, async (kb) => {
    assert.deepStrictEqual((await kb.list()).map((k) => k.ref), served.map((k) => k.ref), "not re-sorted");
  });
});

// ── resolve ─────────────────────────────────────────────────────────────

test("resolve: a bare name is global, <tenant>/<name> is a tenant KB, the listing's own ref form works", async () => {
  await withKb(async ({ kb }) => {
    assert.strictEqual((await kb.resolve("demo")).ref, "global/demo");
    assert.strictEqual((await kb.resolve("U1/handbook")).ref, "tenant/U1/handbook");
    assert.strictEqual((await kb.resolve("U2/demo")).ref, "tenant/U2/demo");
    assert.strictEqual((await kb.resolve("global/demo")).ref, "global/demo");
    assert.strictEqual((await kb.resolve("tenant/U1/handbook")).ref, "tenant/U1/handbook");
  });
});

test("resolve: a missing KB, a wrong tenant and a bad address are typed", async () => {
  await withKb(async ({ kb }) => {
    let error = await rejectsWith(kb.resolve("nope"), Err.GatewayKnowledgeBaseError);
    assert.strictEqual(error.reason, "not-found");
    assert.strictEqual(error.ref, "nope");
    // a tenant KB is not reachable by its bare name
    error = await rejectsWith(kb.resolve("handbook"), Err.GatewayKnowledgeBaseError);
    assert.strictEqual(error.reason, "not-found");
    error = await rejectsWith(kb.resolve("U9/handbook"), Err.GatewayKnowledgeBaseError);
    assert.strictEqual(error.reason, "not-found");
    for (const bad of ["", "a/b/c", "/demo", "U1/", " demo"]) {
      error = await rejectsWith(kb.resolve(bad), Err.GatewayKnowledgeBaseError);
      assert.strictEqual(error.reason, "bad-ref", bad);
    }
  });
});

test("resolve: two listed matches are ambiguous and name their refs", async () => {
  await withKb(async ({ fake, kb }) => {
    fake.knowledgeBases.push(entry(fake, { name: "demo", title: "Duplicate" }));
    const error = await rejectsWith(kb.resolve("demo"), Err.GatewayKnowledgeBaseError);
    assert.strictEqual(error.reason, "ambiguous");
    assert.deepStrictEqual(error.candidates, ["global/demo", "global/demo"]);
  });
});

test("resolve passes gateway failures through typed", async () => {
  await withKb(async ({ fake, kb }) => {
    fake.revokeToken(TOKEN);
    await rejectsWith(kb.resolve("demo"), Err.GatewayAuthError);
  });
});

// ── pull ────────────────────────────────────────────────────────────────

test("pull clones the live branch into <cwd>/<name> by default and <cwd>/<tenant>-<name> for a tenant KB", async () => {
  await withKb(async ({ kb, demo }) => {
    const cwd = tmp();
    const result = await kb.pull("demo", { cwd });
    assert.strictEqual(result.outcome, "cloned");
    assert.strictEqual(result.dir, path.join(cwd, "demo"));
    assert.strictEqual(result.branch, "master");
    assert.strictEqual(result.from, null);
    assert.strictEqual(result.to, git(demo, "rev-parse", "master"));
    assert.strictEqual(result.kb.ref, "global/demo");
    assert.strictEqual(read(cwd, "demo", "dir", "b.txt"), "bravo\n");

    const tenant = await kb.pull("U1/handbook", { cwd });
    assert.strictEqual(tenant.dir, path.join(cwd, "U1-handbook"));
    assert.strictEqual(read(cwd, "U1-handbook", "h.txt"), "hand\n");
  });
});

test("pull into an explicit dir (relative to cwd) and into an existing empty folder", async () => {
  await withKb(async ({ kb }) => {
    const cwd = tmp();
    fs.mkdirSync(path.join(cwd, "empty"));
    const result = await kb.pull("demo", { cwd, dir: "empty" });
    assert.strictEqual(result.outcome, "cloned");
    assert.strictEqual(read(cwd, "empty", "a.txt"), "alpha\n");
    const nested = await kb.pull("demo", { cwd, dir: path.join("x", "y") });
    assert.strictEqual(nested.dir, path.join(cwd, "x", "y"));
  });
});

test("pull of an existing clone of the same KB fast-forwards, then reports up-to-date", async () => {
  await withKb(async ({ kb, demo }) => {
    const cwd = tmp();
    const first = await kb.pull("demo", { cwd });
    const upToDate = await kb.pull("demo", { cwd });
    assert.strictEqual(upToDate.outcome, "up-to-date");
    commitToRemote(demo, "master", { "new.txt": "new\n" });
    const moved = await kb.pull("demo", { cwd });
    assert.strictEqual(moved.outcome, "fast-forwarded");
    assert.strictEqual(moved.from, first.to);
    assert.strictEqual(moved.to, git(demo, "rev-parse", "master"));
    assert.strictEqual(read(cwd, "demo", "new.txt"), "new\n");
  });
});

test("pull of a clone not on the live branch, detached, or on a retired live branch is refused before any fetch", async () => {
  await withKb(async ({ fake, kb, demo }) => {
    const cwd = tmp();
    const { dir } = await kb.pull("demo", { cwd });
    git(dir, "checkout", "-q", "-b", "side");
    let before = fake.requests.length;
    let error = await rejectsWith(kb.pull("demo", { cwd }), Err.GatewayKnowledgeBaseError);
    assert.strictEqual(error.reason, "wrong-branch");
    assert.strictEqual(error.ref, "global/demo");
    assert.strictEqual(error.branch, "side");
    assert.strictEqual(error.liveBranch, "master");
    assert.deepStrictEqual(fake.requests.slice(before).map((r) => r.path), ["/api/v1/knowledge-bases"]);

    git(dir, "checkout", "-q", "--detach");
    error = await rejectsWith(kb.pull("demo", { cwd }), Err.GatewayKnowledgeBaseError);
    assert.strictEqual(error.branch, null);

    // the server moved the live branch since the clone was made
    git(dir, "checkout", "-q", "master");
    fake.knowledgeBases[0].liveBranch = "next";
    before = fake.requests.length;
    error = await rejectsWith(kb.pull("demo", { cwd }), Err.GatewayKnowledgeBaseError);
    assert.strictEqual(error.branch, "master");
    assert.strictEqual(error.liveBranch, "next");
    assert.deepStrictEqual(fake.requests.slice(before).map((r) => r.path), ["/api/v1/knowledge-bases"]);
    assert.strictEqual(git(demo, "rev-parse", "master"), git(dir, "rev-parse", "master"));
  });
});

test("pull never prompts: a clean fast-forward needs no prompt provider", async () => {
  await withKb(async ({ kb, demo }) => {
    // the service above is built with prompt: null, so any prompt call would throw
    const cwd = tmp();
    await kb.pull("demo", { cwd });
    commitToRemote(demo, "master", { "n.txt": "n\n" });
    assert.strictEqual((await kb.pull("demo", { cwd })).outcome, "fast-forwarded");
  });
});

test("pull into a clone of a different repository is wrong-repository and changes nothing", async () => {
  await withKb(async ({ kb }) => {
    const cwd = tmp();
    await kb.pull("other", { cwd, dir: "shared" });
    const before = git(path.join(cwd, "shared"), "rev-parse", "HEAD");
    const error = await rejectsWith(kb.pull("demo", { cwd, dir: "shared" }), Err.GatewayWorkingCopyError);
    assert.strictEqual(error.reason, "wrong-repository");
    assert.strictEqual(git(path.join(cwd, "shared"), "rev-parse", "HEAD"), before);
    assert.ok(!fs.existsSync(path.join(cwd, "shared", "a.txt")));
  });
});

test("pull into a folder with files that is not a clone is not-empty", async () => {
  await withKb(async ({ kb }) => {
    const cwd = tmp();
    fs.mkdirSync(path.join(cwd, "demo"));
    fs.writeFileSync(path.join(cwd, "demo", "mine.txt"), "mine\n");
    const error = await rejectsWith(kb.pull("demo", { cwd }), Err.GatewayWorkingCopyError);
    assert.strictEqual(error.reason, "not-empty");
    assert.strictEqual(read(cwd, "demo", "mine.txt"), "mine\n");
  });
});

test("pull whose incoming commits touch a locally changed file throws the dirty paths and changes nothing", async () => {
  await withKb(async ({ kb, demo }) => {
    const cwd = tmp();
    await kb.pull("demo", { cwd });
    const dir = path.join(cwd, "demo");
    fs.writeFileSync(path.join(dir, "a.txt"), "mine\n");
    fs.writeFileSync(path.join(dir, "untouched.txt"), "keep\n");
    commitToRemote(demo, "master", { "a.txt": "theirs\n" });
    const head = git(dir, "rev-parse", "HEAD");
    const error = await rejectsWith(kb.pull("demo", { cwd }), Err.GatewayDirtyWorkingTreeError);
    assert.deepStrictEqual(error.paths, ["a.txt"]);
    assert.strictEqual(read(dir, "a.txt"), "mine\n");
    assert.strictEqual(git(dir, "rev-parse", "HEAD"), head);
  });
});

test("pull of an unknown KB or an unusable name fails before touching the disk", async () => {
  await withKb(async ({ fake, kb }) => {
    const cwd = tmp();
    await rejectsWith(kb.pull("nope", { cwd }), Err.GatewayKnowledgeBaseError);
    fake.knowledgeBases.push(entry(fake, { name: "..", ref: "global/.." }));
    const error = await rejectsWith(kb.pull("..", { cwd }), Err.GatewayKnowledgeBaseError);
    assert.strictEqual(error.reason, "unsafe-name");
    assert.deepStrictEqual(fs.readdirSync(cwd), []);
  });
});

test("pull refuses a listed name or tenant that is not a safe folder name, creating nothing and cloning nothing", async () => {
  const hostile = [
    ".git",
    ".GIT",
    ".hidden",
    "GIT~1",
    "git~12",
    "CON",
    "nul.txt",
    "COM1",
    "COM\u00b9",
    "LPT\u00b2",
    "trailing.",
    "trailing ",
    "a\u0001b",
    "a\u007fb",
    "a\u001fb",
    "a:b",
    "a\\b",
    "CONIN$",
    "conout$",
    "COM0",
    "LPT0",
    "CON .txt",
    "\u200c.git",
    "a\u200bb",
    "a\u202eb",
    "a\u2060b",
    "a\ufeffb",
    "a\u00adb",
  ];
  for (const bad of hostile) {
    await withKb(async ({ fake, kb }) => {
      const cwd = tmp();
      fake.knowledgeBases.push(entry(fake, { name: bad, ref: `global/${bad}` }));
      fake.knowledgeBases.push(entry(fake, { name: "ok", tenant: bad, ref: `tenant/${bad}/ok` }));
      const before = fake.requests.length;
      for (const ref of [bad, `${bad}/ok`]) {
        // control and format characters never get past the listing check; the rest reach the name check
        if (/[\p{Cc}\p{Cf}]/u.test(bad)) {
          await rejectsWith(kb.pull(ref, { cwd }), Err.GatewayUnexpectedResponseError);
          continue;
        }
        const error = await rejectsWith(kb.pull(ref, { cwd }), Err.GatewayKnowledgeBaseError);
        // an address with edge whitespace is refused earlier, as a bad address
        const expected = bad === bad.trim() ? "unsafe-name" : "bad-ref";
        assert.strictEqual(error.reason, expected, JSON.stringify(ref));
      }
      assert.deepStrictEqual(fs.readdirSync(cwd), [], JSON.stringify(bad));
      assert.ok(
        fake.requests.slice(before).every((r) => r.path === "/api/v1/knowledge-bases"),
        `no clone request for ${JSON.stringify(bad)}`
      );
    });
  }
});

test("pull and push refuse a clone whose branch tracks a branch other than the live one, touching nothing", async () => {
  await withKb(async ({ fake, kb, demo }) => {
    const cwd = tmp();
    const { dir } = await kb.pull("demo", { cwd });
    commitToRemote(demo, "draft", { "d.txt": "d\n" });
    git(dir, "config", "branch.master.merge", "refs/heads/draft");
    fs.writeFileSync(path.join(dir, "x.txt"), "x\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "local");
    const head = git(dir, "rev-parse", "HEAD");
    const draft = git(demo, "rev-parse", "draft");
    const before = fake.requests.length;
    for (const op of [() => kb.pull("demo", { cwd }), () => kb.push(dir)]) {
      const error = await rejectsWith(op(), Err.GatewayKnowledgeBaseError);
      assert.strictEqual(error.reason, "wrong-branch");
      assert.strictEqual(error.branch, "master");
      assert.strictEqual(error.liveBranch, "master");
      assert.strictEqual(error.upstream, "origin/draft");
    }
    assert.ok(fake.requests.slice(before).every((r) => r.path === "/api/v1/knowledge-bases"));
    assert.strictEqual(git(dir, "rev-parse", "HEAD"), head);
    assert.strictEqual(git(demo, "rev-parse", "draft"), draft);

    git(dir, "config", "--unset", "branch.master.merge");
    const none = await rejectsWith(kb.push(dir), Err.GatewayKnowledgeBaseError);
    assert.strictEqual(none.upstream, null);
  });
});

test("push resolves a relative dir against the cwd it is given, never process.cwd()", async () => {
  await withKb(async ({ kb, demo }) => {
    const cwd = tmp();
    await kb.pull("demo", { cwd });
    fs.writeFileSync(path.join(cwd, "demo", "r.txt"), "r\n");
    git(path.join(cwd, "demo"), "add", "-A");
    git(path.join(cwd, "demo"), "commit", "-m", "rel");
    await rejectsWith(kb.push("demo"), Err.GatewayInvalidArgumentError);
    await rejectsWith(kb.push("demo", { cwd: "relative" }), Err.GatewayInvalidArgumentError);
    await rejectsWith(kb.pull("demo", { cwd: "relative" }), Err.GatewayInvalidArgumentError);
    const result = await kb.push("demo", { cwd });
    assert.strictEqual(result.pushed, true);
    assert.strictEqual(git(demo, "rev-parse", "master"), result.commit);
  });
});

test("a listing entry with control or format characters in a text field is an invalid listing", async () => {
  const good = { ref: "global/a", scope: "global", tenant: null, name: "a", title: "A", liveBranch: "master", canPush: true, gitUrl: "http://x/a.git" };
  const bad = ["\u001b[31mred", "a\u0007b", "a\u200bb", "a\u202eb", "a\ufeffb", "a\u007fb"];
  for (const field of ["ref", "name", "title", "liveBranch"]) {
    for (const value of bad) {
      await withBody({ knowledgeBases: [{ ...good, [field]: value }] }, async (kb) => {
        await rejectsWith(kb.list(), Err.GatewayUnexpectedResponseError);
      });
    }
  }
  await withBody({ knowledgeBases: [{ ...good, scope: "tenant", tenant: "U\u001b1" }] }, async (kb) => {
    await rejectsWith(kb.list(), Err.GatewayUnexpectedResponseError);
  });
});

// ── push ────────────────────────────────────────────────────────────────

test("push sends local commits to the live branch and returns {pushed, commit, ref}", async () => {
  await withKb(async ({ kb, demo }) => {
    const cwd = tmp();
    await kb.pull("demo", { cwd });
    const dir = path.join(cwd, "demo");
    fs.writeFileSync(path.join(dir, "added.txt"), "added\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "add a file");
    const result = await kb.push(dir);
    assert.deepStrictEqual(result, { pushed: true, commit: git(dir, "rev-parse", "HEAD"), ref: "global/demo" });
    assert.strictEqual(git(demo, "rev-parse", "master"), result.commit);

    const again = await kb.push(dir);
    assert.strictEqual(again.pushed, false);
    assert.strictEqual(again.ref, "global/demo");
  });
});

// Answer the git-receive-pack POST with `409 live-branch-unprotected`, ahead of git's own backend.
function refuseUnprotected(fake) {
  const backend = fake.routes.find((r) => r.method === "POST");
  const delegate = backend.handler;
  backend.handler = (req, res) => {
    if (!req.url.endsWith("git-receive-pack")) {
      return delegate(req, res);
    }
    req.resume();
    res.writeHead(409, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "live-branch-unprotected", message: "protection rule missing" }));
  };
}

test("a push the gateway refuses with 409 live-branch-unprotected is that typed error, not non-fast-forward", async () => {
  await withKb(async ({ fake, demo, kb, service }) => {
    const cwd = tmp();
    const { dir } = await kb.pull("demo", { cwd });
    fs.writeFileSync(path.join(dir, "u.txt"), "u\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "unprotected");
    const before = git(demo, "rev-parse", "master");
    refuseUnprotected(fake);
    for (const push of [() => kb.push(dir), () => service.git.push(dir)]) {
      const error = await rejectsWith(push(), Err.GatewayLiveBranchUnprotectedError);
      assert.ok(error instanceof Err.GatewayConflictError);
      assert.strictEqual(error.code, "live-branch-unprotected");
      assert.strictEqual(error.status, 409);
      assert.ok(/not protected/.test(error.message) && /nothing was pushed/.test(error.message), error.message);
      assert.ok(!/fast-forward/i.test(error.message), error.message);
    }
    assert.strictEqual(git(demo, "rev-parse", "master"), before);
  });
});

test("push to a tenant KB reports its tenant ref", async () => {
  await withKb(async ({ kb, handbook }) => {
    const cwd = tmp();
    const { dir } = await kb.pull("U1/handbook", { cwd });
    fs.writeFileSync(path.join(dir, "t.txt"), "t\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "tenant change");
    const result = await kb.push(dir);
    assert.strictEqual(result.ref, "tenant/U1/handbook");
    assert.strictEqual(git(handbook, "rev-parse", "master"), result.commit);
  });
});

test("push where canPush is false is refused early with the ref, and nothing reaches the git routes", async () => {
  await withKb(async ({ fake, kb }) => {
    const cwd = tmp();
    const { dir } = await kb.pull("other", { cwd });
    fs.writeFileSync(path.join(dir, "x.txt"), "x\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "try");
    const before = fake.requests.length;
    const error = await rejectsWith(kb.push(dir), Err.GatewayKnowledgeBasePushNotPermittedError);
    assert.ok(error instanceof Err.GatewayNotPermittedError);
    assert.strictEqual(error.ref, "global/other");
    const sent = fake.requests.slice(before);
    assert.deepStrictEqual(sent.map((r) => r.path), ["/api/v1/knowledge-bases"]);
  });
});

test("push consults a fresh listing: a permission withdrawn since the pull is honoured", async () => {
  await withKb(async ({ fake, kb }) => {
    const cwd = tmp();
    const { dir } = await kb.pull("demo", { cwd });
    fs.writeFileSync(path.join(dir, "x.txt"), "x\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "try");
    fake.knowledgeBases[0].canPush = false;
    await rejectsWith(kb.push(dir), Err.GatewayKnowledgeBasePushNotPermittedError);
  });
});

test("push from a clone not on the live branch, or detached, is refused early with ref and branches", async () => {
  await withKb(async ({ fake, kb }) => {
    const cwd = tmp();
    const { dir } = await kb.pull("demo", { cwd });
    git(dir, "checkout", "-q", "-b", "side");
    fs.writeFileSync(path.join(dir, "s.txt"), "s\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "side");
    let before = fake.requests.length;
    let error = await rejectsWith(kb.push(dir), Err.GatewayKnowledgeBaseError);
    assert.strictEqual(error.reason, "wrong-branch");
    assert.strictEqual(error.ref, "global/demo");
    assert.strictEqual(error.branch, "side");
    assert.strictEqual(error.liveBranch, "master");
    assert.deepStrictEqual(fake.requests.slice(before).map((r) => r.path), ["/api/v1/knowledge-bases"]);

    git(dir, "checkout", "-q", "--detach");
    before = fake.requests.length;
    error = await rejectsWith(kb.push(dir), Err.GatewayKnowledgeBaseError);
    assert.strictEqual(error.reason, "wrong-branch");
    assert.strictEqual(error.branch, null);
    assert.deepStrictEqual(fake.requests.slice(before).map((r) => r.path), ["/api/v1/knowledge-bases"]);
  });
});

test("push of a non-fast-forward is a GatewayConflictError", async () => {
  await withKb(async ({ kb, demo }) => {
    const cwd = tmp();
    const { dir } = await kb.pull("demo", { cwd });
    fs.writeFileSync(path.join(dir, "mine.txt"), "mine\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "mine");
    commitToRemote(demo, "master", { "theirs.txt": "theirs\n" });
    await rejectsWith(kb.push(dir), Err.GatewayConflictError);
  });
});

test("push from a folder that is not a clone, or a clone of an unlisted repository, is typed", async () => {
  await withKb(async ({ fake, kb }) => {
    const cwd = tmp();
    const empty = path.join(cwd, "empty");
    fs.mkdirSync(empty);
    const notClone = await rejectsWith(kb.push(empty), Err.GatewayWorkingCopyError);
    assert.strictEqual(notClone.reason, "not-a-clone");

    const { dir } = await kb.pull("demo", { cwd });
    fake.knowledgeBases = fake.knowledgeBases.filter((k) => k.ref !== "global/demo");
    const unlisted = await rejectsWith(kb.push(dir), Err.GatewayKnowledgeBaseError);
    assert.strictEqual(unlisted.reason, "not-a-kb");
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
    console.log(`  ✓ the token never appears in a thrown message or log line (${thrownMessages.length} errors, ${logLines.length} log lines)`);
  }

  for (const dir of scratch) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (failures > 0) {
    console.error(`\nGatewayKb: ${failures} failing`);
    process.exit(1);
  }
  console.log(`\nGatewayKb: all ${pending.length + 1} passing`);
})();
