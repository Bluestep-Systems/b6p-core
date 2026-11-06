// Behavioral spec for `core.gateway.marketplace`: list marketplace repos and pull a plain working
// clone of one.
//
// What it pins: the listing is validated (a bad shape is GatewayUnexpectedResponseError); get() of
// a missing name is GatewayNotFoundError; pull clones the default branch, a named branch or a tag
// into a folder (default: the repo's name); an existing clone of the same repo is fast-forwarded
// (a tag checkout is already up to date); a folder holding another repo's clone, or a clone on
// another ref, is refused and left untouched; a pull that would overwrite local changes is
// refused with the paths; there is no push surface; the token never reaches a message.
//
// Dependency-free node script (run via `npm test`). Exercises the COMPILED output in dist/. Needs
// `git` on PATH to build fixtures and serve them. All paths are built with node:path under
// os.tmpdir(), so it runs the same on Windows and POSIX.

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Err, FakeGateway, GatewayService, MockFileSystem } = require("../dist/index.js");
const { mountGitBackend, seedRepo, commitToRemote, git } = require("./support/GitHttpBackend");

const TOKEN = "b6pt_spec_marketmarket0123456789";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b6p-marketspec-"));
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

/** A fake gateway with two seeded marketplace repos, `core` (tags v1, annotated v2) and `extras`. */
async function withMarket(fn) {
  const fake = await FakeGateway.start();
  fake.grantToken(TOKEN, ["registry:read"]);
  const backend = mountGitBackend(fake, new Set(), "registry:read");
  const core = seedRepo(backend, "marketplace", "core", { "a.txt": "alpha\n", "dir/b.txt": "bravo\n" });
  git(core, "tag", "v1", "master");
  commitToRemote(core, "master", { "a.txt": "alpha two\n" }, "second");
  git(core, "tag", "-a", "v2", "-m", "v2", "master");
  const extras = seedRepo(backend, "marketplace", "extras", { "x.txt": "x\n" });
  const entry = (name, tags) => ({
    name,
    description: `${name} repo`,
    defaultBranch: "master",
    tags,
    gitUrl: fake.gitUrl("marketplace", name),
  });
  fake.repos = [entry("core", ["v1", "v2"]), entry("extras", [])];
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
    await fn({ fake, service, core, extras, market: service.marketplace });
  } finally {
    await fake.stop();
    backend.cleanup();
  }
}

const read = (...p) => fs.readFileSync(path.join(...p), "utf8");

// ── list / get ──────────────────────────────────────────────────────────

test("list returns typed repos with their tags", async () => {
  await withMarket(async ({ market, fake }) => {
    const repos = await market.list();
    assert.deepStrictEqual(
      repos.map((r) => r.name),
      ["core", "extras"]
    );
    assert.deepStrictEqual(repos[0].tags, ["v1", "v2"]);
    assert.strictEqual(repos[0].defaultBranch, "master");
    assert.strictEqual(repos[0].gitUrl, fake.gitUrl("marketplace", "core"));
    assert.strictEqual(repos[0].description, "core repo");
  });
});

test("a listing of the wrong shape is GatewayUnexpectedResponseError", async () => {
  const goodUrl = "https://gateway.invalid/x.git";
  const bads = [
    [{ name: "ok", description: "", defaultBranch: "master", tags: [1], gitUrl: goodUrl }],
    [{ name: "ok", description: "", defaultBranch: "", tags: [], gitUrl: goodUrl }],
    [{ name: "ok", description: "", defaultBranch: "master", tags: [], gitUrl: 7 }],
    [{ name: "ok", defaultBranch: "master", tags: [], gitUrl: goodUrl }],
    [{ name: "../escape", description: "", defaultBranch: "master", tags: [], gitUrl: goodUrl }],
    [{ name: "a/b", description: "", defaultBranch: "master", tags: [], gitUrl: goodUrl }],
    ["not an object"],
  ];
  for (const repos of bads) {
    await withMarket(async ({ market, fake }) => {
      fake.repos = repos;
      await rejectsWith(market.list(), Err.GatewayUnexpectedResponseError);
    });
  }
  await withMarket(async ({ market, fake }) => {
    fake.route({
      method: "GET",
      prefix: "/api/v1/registry/repos",
      handler: (req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ nope: [] }));
      },
    });
    await rejectsWith(market.list(), Err.GatewayUnexpectedResponseError);
  });
});

test("get finds a repo by name, and a missing name is GatewayNotFoundError", async () => {
  await withMarket(async ({ market }) => {
    assert.strictEqual((await market.get("extras")).name, "extras");
    const error = await rejectsWith(market.get("nope"), Err.GatewayNotFoundError);
    assert.strictEqual(error.status, 404);
  });
});

// ── pull ────────────────────────────────────────────────────────────────

test("pull clones the default branch into ./<name> when no folder is given", async () => {
  await withMarket(async ({ market, core }) => {
    const cwd = process.cwd();
    const base = tmp();
    process.chdir(base);
    try {
      const result = await market.pull("core");
      const dir = path.resolve(base, "core");
      assert.strictEqual(fs.realpathSync(result.dir), fs.realpathSync(dir));
      assert.strictEqual(result.action, "cloned");
      assert.strictEqual(result.ref, "master");
      assert.strictEqual(result.branch, "master");
      assert.strictEqual(result.head, git(core, "rev-parse", "master"));
      assert.strictEqual(read(dir, "a.txt"), "alpha two\n");
      assert.strictEqual(git(dir, "status", "--porcelain"), "");
    } finally {
      process.chdir(cwd);
    }
  });
});

test("pull clones a named branch and a tag (lightweight and annotated)", async () => {
  await withMarket(async ({ market, core }) => {
    commitToRemote(core, "dev", { "dev.txt": "dev\n" });
    const onDev = path.join(tmp(), "dev");
    const dev = await market.pull("core", onDev, { ref: "dev" });
    assert.strictEqual(dev.branch, "dev");
    assert.strictEqual(read(onDev, "dev.txt"), "dev\n");

    const onV1 = path.join(tmp(), "v1");
    const v1 = await market.pull("core", onV1, { ref: "v1" });
    assert.strictEqual(v1.branch, null);
    assert.strictEqual(v1.head, git(core, "rev-parse", "v1"));
    assert.strictEqual(read(onV1, "a.txt"), "alpha\n");

    const onV2 = path.join(tmp(), "v2");
    const v2 = await market.pull("core", onV2, { ref: "v2" });
    assert.strictEqual(v2.branch, null);
    assert.strictEqual(v2.head, git(core, "rev-parse", "v2^{commit}"));
  });
});

test("an unknown ref is GatewayWorkingCopyError ref-not-found and leaves no folder", async () => {
  await withMarket(async ({ market }) => {
    const dir = path.join(tmp(), "none");
    const error = await rejectsWith(market.pull("core", dir, { ref: "nope" }), Err.GatewayWorkingCopyError);
    assert.strictEqual(error.reason, "ref-not-found");
    assert.ok(!fs.existsSync(dir));
  });
});

test("pull of a missing repo is GatewayNotFoundError and creates nothing", async () => {
  await withMarket(async ({ market }) => {
    const dir = path.join(tmp(), "none");
    await rejectsWith(market.pull("nope", dir), Err.GatewayNotFoundError);
    assert.ok(!fs.existsSync(dir));
  });
});

test("pull fast-forwards an existing clone, then reports up to date", async () => {
  await withMarket(async ({ market, core }) => {
    const dir = path.join(tmp(), "core");
    await market.pull("core", dir);
    const before = git(dir, "rev-parse", "HEAD");
    const next = commitToRemote(core, "master", { "new.txt": "new\n" }, "third");
    const ff = await market.pull("core", dir);
    assert.strictEqual(ff.action, "fast-forwarded");
    assert.strictEqual(ff.from, before);
    assert.strictEqual(ff.head, next);
    assert.strictEqual(read(dir, "new.txt"), "new\n");
    const again = await market.pull("core", dir);
    assert.strictEqual(again.action, "up-to-date");
    assert.strictEqual(again.head, next);
  });
});

test("an existing tag checkout is already up to date, even when the branch moves on", async () => {
  await withMarket(async ({ market, core }) => {
    const dir = path.join(tmp(), "core");
    await market.pull("core", dir, { ref: "v2" });
    commitToRemote(core, "master", { "new.txt": "new\n" }, "third");
    const result = await market.pull("core", dir, { ref: "v2" });
    assert.strictEqual(result.action, "up-to-date");
    assert.strictEqual(result.branch, null);
    assert.ok(!fs.existsSync(path.join(dir, "new.txt")));
  });
});

test("a clone with its own commits reports ahead and keeps them", async () => {
  await withMarket(async ({ market }) => {
    const dir = path.join(tmp(), "core");
    await market.pull("core", dir);
    git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "mine");
    const head = git(dir, "rev-parse", "HEAD");
    const result = await market.pull("core", dir);
    assert.strictEqual(result.action, "ahead");
    assert.strictEqual(git(dir, "rev-parse", "HEAD"), head);
  });
});

test("a folder holding another repo's clone is refused and left untouched", async () => {
  await withMarket(async ({ market }) => {
    const dir = path.join(tmp(), "folder");
    await market.pull("extras", dir);
    const before = git(dir, "rev-parse", "HEAD");
    const error = await rejectsWith(market.pull("core", dir), Err.GatewayCloneMismatchError);
    assert.strictEqual(error.reason, "different-repo");
    assert.strictEqual(error.repo, "core");
    assert.strictEqual(git(dir, "rev-parse", "HEAD"), before);
    assert.strictEqual(read(dir, "x.txt"), "x\n");
  });
});

test("a clone on another ref than the one asked for is refused and left untouched", async () => {
  await withMarket(async ({ market, core }) => {
    commitToRemote(core, "dev", { "dev.txt": "dev\n" });
    const dir = path.join(tmp(), "core");
    await market.pull("core", dir);
    const before = git(dir, "rev-parse", "HEAD");
    let error = await rejectsWith(market.pull("core", dir, { ref: "dev" }), Err.GatewayCloneMismatchError);
    assert.strictEqual(error.reason, "different-ref");
    error = await rejectsWith(market.pull("core", dir, { ref: "v1" }), Err.GatewayCloneMismatchError);
    assert.strictEqual(error.reason, "different-ref");

    const onTag = path.join(tmp(), "tag");
    await market.pull("core", onTag, { ref: "v1" });
    error = await rejectsWith(market.pull("core", onTag, { ref: "v2" }), Err.GatewayCloneMismatchError);
    assert.strictEqual(error.reason, "different-ref");
    error = await rejectsWith(market.pull("core", onTag), Err.GatewayCloneMismatchError);
    assert.strictEqual(error.reason, "different-ref");
    assert.strictEqual(git(dir, "rev-parse", "HEAD"), before);
  });
});

test("a non-empty folder that is not a clone is GatewayWorkingCopyError not-empty", async () => {
  await withMarket(async ({ market }) => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "mine.txt"), "mine\n");
    const error = await rejectsWith(market.pull("core", dir), Err.GatewayWorkingCopyError);
    assert.strictEqual(error.reason, "not-empty");
    assert.strictEqual(read(dir, "mine.txt"), "mine\n");
  });
});

test("a pull that would overwrite local changes is refused with the paths", async () => {
  await withMarket(async ({ market, core }) => {
    const dir = path.join(tmp(), "core");
    await market.pull("core", dir);
    commitToRemote(core, "master", { "a.txt": "remote\n" }, "third");
    fs.writeFileSync(path.join(dir, "a.txt"), "local edit\n");
    const error = await rejectsWith(market.pull("core", dir), Err.GatewayDirtyWorkingTreeError);
    assert.deepStrictEqual(error.paths, ["a.txt"]);
    assert.strictEqual(read(dir, "a.txt"), "local edit\n");
  });
});

test("the marketplace has no push surface, and every request carried the token", async () => {
  await withMarket(async ({ market, fake }) => {
    assert.strictEqual(market.push, undefined);
    await market.pull("core", path.join(tmp(), "core"));
    assert.ok(fake.requests.length >= 2);
    for (const r of fake.requests) {
      assert.strictEqual(r.authorization, `Bearer ${TOKEN}`);
    }
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
    console.error(`\nGatewayMarketplace: ${failures} failing`);
    process.exit(1);
  }
  console.log(`\nGatewayMarketplace: all ${pending.length + 1} passing`);
})();
