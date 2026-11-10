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

/** Pull into `dir` (absolute in these specs) with the consumer's cwd. */
const pullAt = (market, name, dir, options = {}) => market.pull(name, { cwd: os.tmpdir(), dir, ...options });

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

test("list keeps the server's order and accepts an empty description (the registry sends \"\" when absent)", async () => {
  await withMarket(async ({ market, fake }) => {
    const entry = (name) => ({ name, description: "", defaultBranch: "master", tags: ["v2", "v10"], gitUrl: fake.gitUrl("marketplace", name) });
    fake.repos = [entry("zeta"), entry("alpha")];
    const repos = await market.list();
    assert.deepStrictEqual(repos.map((r) => r.name), ["zeta", "alpha"], "not re-sorted");
    assert.strictEqual(repos[0].description, "");
    assert.deepStrictEqual(repos[0].tags, ["v2", "v10"], "tags not re-sorted");
  });
});

test("a malformed entry is skipped: it does not break list, get or pull for the others", async () => {
  await withMarket(async ({ market, fake }) => {
    const good = fake.repos[0];
    fake.repos = [
      { name: "nodesc", defaultBranch: "master", tags: [], gitUrl: good.gitUrl },
      "not an object",
      { ...good, name: "badtags", tags: [1] },
      { ...good, name: "nourl", gitUrl: 7 },
      { ...good, name: "emptybranch", defaultBranch: "" },
      good,
    ];
    assert.deepStrictEqual(
      (await market.list()).map((r) => r.name),
      ["core"]
    );
    assert.strictEqual((await market.get("core")).name, "core");
    const error = await rejectsWith(market.get("nodesc"), Err.GatewayUnexpectedResponseError);
    assert.ok(!/gateway\.invalid/.test(error.message));
    await rejectsWith(market.get("absent"), Err.GatewayNotFoundError);
    const dir = path.join(tmp(), "c");
    assert.strictEqual((await pullAt(market, "core", dir)).action, "cloned");
  });
});

test("a body that is not a listing is GatewayUnexpectedResponseError", async () => {
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

test("an unsafe repo name blocks only a pull that would use it as a folder", async () => {
  const names = [
    "..",
    ".",
    ".git",
    ".GIT",
    ".Git",
    ".hidden",
    "GIT~1",
    "git~12",
    "a\x01b",
    "a\x1fb",
    "\x7f",
    "COM\u00b9",
    "LPT\u00b2",
    "com\u00b3.txt",
    "a/b",
    "a\\b",
    "C:",
    "a:b",
    "a*",
    "a?",
    'a"',
    "a<",
    "a>",
    "a|",
    " pad",
    "pad ",
    "dot.",
    "CON",
    "nul",
    "COM1",
    "lpt9",
    "con.txt",
    "CONIN$",
    "conout$",
    "COM0",
    "LPT0",
    "CON .txt",
    "nul  .x",
    "\u200c.git",
    "a\u200bb",
    "a\u202eb",
    "a\u2060b",
    "\ufeffname",
    "a\u00adb",
    "",
  ];
  for (const name of names) {
    await withMarket(async ({ market, fake }) => {
      fake.repos = [{ ...fake.repos[0], name }];
      const listed = await market.list();
      // control and format characters make the entry malformed (skipped); other odd names stay listed
      const malformed = /[\p{Cc}\p{Cf}]/u.test(name);
      assert.strictEqual(listed.length, malformed ? 0 : 1, `list for ${JSON.stringify(name)}`);
      const base = tmp();
      await rejectsWith(market.pull(name, { cwd: base }), Err.GatewayUnexpectedResponseError);
      if (malformed) {
        await rejectsWith(market.get(name), Err.GatewayUnexpectedResponseError);
      }
      assert.deepStrictEqual(fs.readdirSync(base), [], `nothing created for ${JSON.stringify(name)}`);
      assert.ok(
        !fake.requests.some((r) => r.path.startsWith("/api/v1/git")),
        `no clone request sent for ${JSON.stringify(name)}`
      );
    });
  }
  // an explicit dir needs no safe name
  await withMarket(async ({ market, fake }) => {
    fake.repos = [{ ...fake.repos[0], name: "CON" }];
    const dir = path.join(tmp(), "ok");
    assert.strictEqual((await pullAt(market, "CON", dir)).action, "cloned");
  });
  // ordinary names pass
  await withMarket(async ({ market, fake }) => {
    fake.repos = [{ ...fake.repos[0], name: "my-repo_2.x" }];
    const base = tmp();
    assert.strictEqual((await market.pull("my-repo_2.x", { cwd: base })).action, "cloned");
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

test("pull with no dir clones into <cwd>/<name>; a relative dir resolves against cwd", async () => {
  await withMarket(async ({ market, core }) => {
    const base = tmp();
    const before = process.cwd();
    const result = await market.pull("core", { cwd: base });
    assert.strictEqual(process.cwd(), before);
    assert.strictEqual(result.dir, path.join(base, "core"));
    assert.strictEqual(result.action, "cloned");
    assert.strictEqual(result.ref, "master");
    assert.strictEqual(result.branch, "master");
    assert.strictEqual(result.head, git(core, "rev-parse", "master"));
    assert.strictEqual(read(base, "core", "a.txt"), "alpha two\n");
    const rel = await market.pull("extras", { cwd: base, dir: path.join("sub", "x") });
    assert.strictEqual(rel.dir, path.join(base, "sub", "x"));
    assert.strictEqual(read(base, "sub", "x", "x.txt"), "x\n");
  });
});

test("pull clones a named branch and a tag (lightweight and annotated)", async () => {
  await withMarket(async ({ market, core }) => {
    commitToRemote(core, "dev", { "dev.txt": "dev\n" });
    const onDev = path.join(tmp(), "dev");
    const dev = await pullAt(market, "core", onDev, { ref: "dev" });
    assert.strictEqual(dev.branch, "dev");
    assert.strictEqual(read(onDev, "dev.txt"), "dev\n");

    const onV1 = path.join(tmp(), "v1");
    const v1 = await pullAt(market, "core", onV1, { ref: "v1" });
    assert.strictEqual(v1.branch, null);
    assert.strictEqual(v1.head, git(core, "rev-parse", "v1"));
    assert.strictEqual(read(onV1, "a.txt"), "alpha\n");

    const onV2 = path.join(tmp(), "v2");
    const v2 = await pullAt(market, "core", onV2, { ref: "v2" });
    assert.strictEqual(v2.branch, null);
    assert.strictEqual(v2.head, git(core, "rev-parse", "v2^{commit}"));
  });
});

test("an unknown ref is GatewayWorkingCopyError ref-not-found and leaves no folder", async () => {
  await withMarket(async ({ market }) => {
    const dir = path.join(tmp(), "none");
    const error = await rejectsWith(pullAt(market, "core", dir, { ref: "nope" }), Err.GatewayWorkingCopyError);
    assert.strictEqual(error.reason, "ref-not-found");
    assert.ok(!fs.existsSync(dir));
  });
});

test("pull of a missing repo is GatewayNotFoundError and creates nothing", async () => {
  await withMarket(async ({ market }) => {
    const dir = path.join(tmp(), "none");
    await rejectsWith(pullAt(market, "nope", dir), Err.GatewayNotFoundError);
    assert.ok(!fs.existsSync(dir));
  });
});

test("pull fast-forwards an existing clone, then reports up to date", async () => {
  await withMarket(async ({ market, core }) => {
    const dir = path.join(tmp(), "core");
    await pullAt(market, "core", dir);
    const before = git(dir, "rev-parse", "HEAD");
    const next = commitToRemote(core, "master", { "new.txt": "new\n" }, "third");
    const ff = await pullAt(market, "core", dir);
    assert.strictEqual(ff.action, "fast-forwarded");
    assert.strictEqual(ff.from, before);
    assert.strictEqual(ff.head, next);
    assert.strictEqual(read(dir, "new.txt"), "new\n");
    const again = await pullAt(market, "core", dir);
    assert.strictEqual(again.action, "up-to-date");
    assert.strictEqual(again.head, next);
  });
});

test("an existing tag checkout is already up to date, even when the branch moves on", async () => {
  await withMarket(async ({ market, core }) => {
    const dir = path.join(tmp(), "core");
    await pullAt(market, "core", dir, { ref: "v2" });
    commitToRemote(core, "master", { "new.txt": "new\n" }, "third");
    const result = await pullAt(market, "core", dir, { ref: "v2" });
    assert.strictEqual(result.action, "up-to-date");
    assert.strictEqual(result.branch, null);
    assert.ok(!fs.existsSync(path.join(dir, "new.txt")));
  });
});

test("a tag that moved or was deleted on the gateway is GatewayCloneMismatchError tag-moved", async () => {
  await withMarket(async ({ market, core }) => {
    const dir = path.join(tmp(), "core");
    await pullAt(market, "core", dir, { ref: "v1" });
    const head = git(dir, "rev-parse", "HEAD");
    assert.strictEqual((await pullAt(market, "core", dir, { ref: "v1" })).action, "up-to-date");
    git(core, "tag", "-f", "v1", "master");
    let error = await rejectsWith(pullAt(market, "core", dir, { ref: "v1" }), Err.GatewayCloneMismatchError);
    assert.strictEqual(error.reason, "tag-moved");
    assert.strictEqual(git(dir, "rev-parse", "HEAD"), head);
    git(core, "tag", "-d", "v1");
    error = await rejectsWith(pullAt(market, "core", dir, { ref: "v1" }), Err.GatewayCloneMismatchError);
    assert.strictEqual(error.reason, "tag-gone");
  });
});

test("an annotated tag that has not moved is up to date", async () => {
  await withMarket(async ({ market }) => {
    const dir = path.join(tmp(), "core");
    await pullAt(market, "core", dir, { ref: "v2" });
    assert.strictEqual((await pullAt(market, "core", dir, { ref: "v2" })).action, "up-to-date");
  });
});

test("control and format characters in any listing text field make the entry malformed", async () => {
  const bad = ["a\u0007b", "a\u200bb", "\ufeff", "a\u202eb"];
  for (const field of ["description", "defaultBranch"]) {
    for (const value of bad) {
      await withMarket(async ({ market, fake }) => {
        fake.repos = [{ ...fake.repos[0], [field]: value }, fake.repos[1]];
        assert.deepStrictEqual(
          (await market.list()).map((r) => r.name),
          ["extras"],
          `${field} ${JSON.stringify(value)}`
        );
      });
    }
  }
  for (const value of bad) {
    await withMarket(async ({ market, fake }) => {
      fake.repos = [{ ...fake.repos[0], tags: ["v1", value] }, fake.repos[1]];
      assert.deepStrictEqual(
        (await market.list()).map((r) => r.name),
        ["extras"]
      );
      const error = await rejectsWith(market.get("core"), Err.GatewayUnexpectedResponseError);
      assert.ok(!error.message.includes(value));
    });
  }
  // ordinary Unicode text is fine
  await withMarket(async ({ market, fake }) => {
    fake.repos = [{ ...fake.repos[0], description: "Caf\u00e9 \u65e5\u672c\u8a9e" }];
    assert.strictEqual((await market.list()).length, 1);
  });
});

test("core never reads process.cwd(): a relative dir or a missing/relative cwd is refused", async () => {
  await withMarket(async ({ market, fake }) => {
    const base = tmp();
    await rejectsWith(market.pull("core", { dir: "rel" }), Err.GatewayConfigError);
    await rejectsWith(market.pull("core", {}), Err.GatewayConfigError);
    await rejectsWith(market.pull("core", { cwd: "relative" }), Err.GatewayConfigError);
    await rejectsWith(market.pull("core", { cwd: "", dir: "x" }), Err.GatewayConfigError);
    assert.ok(!fake.requests.some((r) => r.path.startsWith("/api/v1/git")));
    // an absolute dir needs no cwd
    const abs = path.join(base, "abs");
    assert.strictEqual((await market.pull("core", { dir: abs })).dir, abs);
  });
});

test("a full ref name is normalised: a second pull with the same ref works", async () => {
  await withMarket(async ({ market, core }) => {
    commitToRemote(core, "dev", { "dev.txt": "dev\n" });
    const onBranch = path.join(tmp(), "dev");
    const first = await pullAt(market, "core", onBranch, { ref: "refs/heads/dev" });
    assert.strictEqual(first.ref, "dev");
    assert.strictEqual(first.branch, "dev");
    assert.strictEqual((await pullAt(market, "core", onBranch, { ref: "refs/heads/dev" })).action, "up-to-date");
    const onTag = path.join(tmp(), "tag");
    assert.strictEqual((await pullAt(market, "core", onTag, { ref: "refs/tags/v1" })).ref, "v1");
    assert.strictEqual((await pullAt(market, "core", onTag, { ref: "refs/tags/v1" })).action, "up-to-date");
  });
});

test("a damaged or non-standard .git is a typed gateway error, not a raw one", async () => {
  await withMarket(async ({ market }) => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, ".git"), "gitdir: /nowhere\n");
    const error = await rejectsWith(pullAt(market, "core", dir), Err.GatewayError);
    assert.ok(error instanceof Err.GatewayWorkingCopyError, error.name);
    const broken = tmp();
    fs.mkdirSync(path.join(broken, ".git"));
    fs.writeFileSync(path.join(broken, ".git", "HEAD"), "garbage\n");
    await rejectsWith(pullAt(market, "core", broken), Err.GatewayError);
  });
});

test("a branch clone whose upstream is not origin/<ref> is refused and left untouched", async () => {
  await withMarket(async ({ market, core }) => {
    commitToRemote(core, "other", { "o.txt": "o\n" });
    const dir = path.join(tmp(), "core");
    await pullAt(market, "core", dir);
    const head = git(dir, "rev-parse", "HEAD");
    git(dir, "config", "branch.master.merge", "refs/heads/other");
    const error = await rejectsWith(pullAt(market, "core", dir), Err.GatewayCloneMismatchError);
    assert.strictEqual(error.reason, "different-ref");
    assert.strictEqual(git(dir, "rev-parse", "HEAD"), head);
  });
});

test("a nested annotated tag (a tag of a tag) is peeled fully", async () => {
  await withMarket(async ({ market, core }) => {
    git(core, "tag", "-a", "v3", "-m", "nested", "refs/tags/v2");
    const dir = path.join(tmp(), "nested");
    const first = await pullAt(market, "core", dir, { ref: "v3" });
    assert.strictEqual(first.head, git(core, "rev-parse", "v2^{commit}"));
    assert.strictEqual((await pullAt(market, "core", dir, { ref: "v3" })).action, "up-to-date");
  });
});

test("a clone with its own commits reports ahead and keeps them", async () => {
  await withMarket(async ({ market }) => {
    const dir = path.join(tmp(), "core");
    await pullAt(market, "core", dir);
    git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "mine");
    const head = git(dir, "rev-parse", "HEAD");
    const result = await pullAt(market, "core", dir);
    assert.strictEqual(result.action, "ahead");
    assert.strictEqual(git(dir, "rev-parse", "HEAD"), head);
  });
});

test("a folder holding another repo's clone is refused and left untouched", async () => {
  await withMarket(async ({ market }) => {
    const dir = path.join(tmp(), "folder");
    await pullAt(market, "extras", dir);
    const before = git(dir, "rev-parse", "HEAD");
    const error = await rejectsWith(pullAt(market, "core", dir), Err.GatewayCloneMismatchError);
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
    await pullAt(market, "core", dir);
    const before = git(dir, "rev-parse", "HEAD");
    let error = await rejectsWith(pullAt(market, "core", dir, { ref: "dev" }), Err.GatewayCloneMismatchError);
    assert.strictEqual(error.reason, "different-ref");
    error = await rejectsWith(pullAt(market, "core", dir, { ref: "v1" }), Err.GatewayCloneMismatchError);
    assert.strictEqual(error.reason, "different-ref");

    const onTag = path.join(tmp(), "tag");
    await pullAt(market, "core", onTag, { ref: "v1" });
    const tagBefore = git(onTag, "rev-parse", "HEAD");
    error = await rejectsWith(pullAt(market, "core", onTag, { ref: "v2" }), Err.GatewayCloneMismatchError);
    assert.strictEqual(error.reason, "different-ref");
    error = await rejectsWith(pullAt(market, "core", onTag), Err.GatewayCloneMismatchError);
    assert.strictEqual(error.reason, "different-ref");
    assert.strictEqual(git(dir, "rev-parse", "HEAD"), before);
    assert.strictEqual(git(onTag, "rev-parse", "HEAD"), tagBefore);
    assert.strictEqual(git(onTag, "status", "--porcelain"), "");
  });
});

test("a non-empty folder that is not a clone is GatewayWorkingCopyError not-empty", async () => {
  await withMarket(async ({ market }) => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "mine.txt"), "mine\n");
    const error = await rejectsWith(pullAt(market, "core", dir), Err.GatewayWorkingCopyError);
    assert.strictEqual(error.reason, "not-empty");
    assert.strictEqual(read(dir, "mine.txt"), "mine\n");
  });
});

test("a pull that would overwrite local changes is refused with the paths", async () => {
  await withMarket(async ({ market, core }) => {
    const dir = path.join(tmp(), "core");
    await pullAt(market, "core", dir);
    commitToRemote(core, "master", { "a.txt": "remote\n" }, "third");
    fs.writeFileSync(path.join(dir, "a.txt"), "local edit\n");
    const error = await rejectsWith(pullAt(market, "core", dir), Err.GatewayDirtyWorkingTreeError);
    assert.deepStrictEqual(error.paths, ["a.txt"]);
    assert.strictEqual(read(dir, "a.txt"), "local edit\n");
  });
});

test("the marketplace has no push surface, and every request carried the token", async () => {
  await withMarket(async ({ market, fake }) => {
    assert.strictEqual(market.push, undefined);
    await pullAt(market, "core", path.join(tmp(), "core"));
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
    console.log(
      `  ✓ the token never appears in a thrown message or log line (${thrownMessages.length} errors, ${logLines.length} log lines)`
    );
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
