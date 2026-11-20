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
    await fn({ fake, service, core, extras, market: service.marketplace, client: service.client });
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

test('list keeps the server\'s order and accepts an empty description (the registry sends "" when absent)', async () => {
  await withMarket(async ({ market, fake }) => {
    const entry = (name) => ({
      name,
      description: "",
      defaultBranch: "master",
      tags: ["v2", "v10"],
      gitUrl: fake.gitUrl("marketplace", name),
    });
    fake.repos = [entry("zeta"), entry("alpha")];
    const repos = await market.list();
    assert.deepStrictEqual(
      repos.map((r) => r.name),
      ["zeta", "alpha"],
      "not re-sorted"
    );
    assert.strictEqual(repos[0].description, "");
    assert.deepStrictEqual(repos[0].tags, ["v2", "v10"], "tags not re-sorted");
  });
});

test("list hands every tag over in the server's order and truncates nothing, even past 1_000", async () => {
  await withMarket(async ({ market, fake }) => {
    const tags = Array.from({ length: 1_200 }, (_, i) => `1.0.${1_199 - i}`);
    fake.repos = [
      { name: "big", description: "d", defaultBranch: "master", tags, gitUrl: fake.gitUrl("marketplace", "big") },
    ];
    const [repo] = await market.list();
    assert.deepStrictEqual(repo.tags, tags, "the client neither re-sorts nor caps the tags (the server owns both)");
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
    // pull looks a name up in the listing, where the malformed entry is named
    const error = await rejectsWith(
      pullAt(market, "nodesc", path.join(tmp(), "n")),
      Err.GatewayUnexpectedResponseError
    );
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
      // get() never sends a name the gateway could not hold (`nul` and `com1` can be marketplace names): not found
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
        await rejectsWith(market.get(name), Err.GatewayNotFoundError);
        assert.ok(!fake.requests.some((r) => r.path.startsWith("/api/v1/registry/repos/")));
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
  await withMarket(async ({ market, fake }) => {
    const extras = await market.get("extras");
    assert.strictEqual(extras.name, "extras");
    assert.deepStrictEqual(
      fake.requests.map((r) => `${r.method} ${r.path}`),
      ["GET /api/v1/registry/repos/extras"]
    );
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
      const pulled = await rejectsWith(
        pullAt(market, "core", path.join(tmp(), "c")),
        Err.GatewayUnexpectedResponseError
      );
      assert.ok(!pulled.message.includes(value));
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

// ── create ──────────────────────────────────────────────────────────────

const posts = (fake) => fake.requests.filter((r) => r.method === "POST" && r.path === "/api/v1/registry/repos");

test("create sends only the members given, answers 201 as created, and does not re-list", async () => {
  await withMarket(async ({ fake, market }) => {
    fake.grantToken(TOKEN, ["registry:read", "registry:push"]);
    const made = await market.create({ name: "kb" });
    assert.strictEqual(made.created, true);
    assert.strictEqual(made.repo.name, "kb");
    assert.strictEqual(made.repo.defaultBranch, "main");
    assert.deepStrictEqual(made.repo.tags, []);
    assert.strictEqual(made.repo.gitUrl, fake.gitUrl("marketplace", "kb"));
    assert.deepStrictEqual(JSON.parse(posts(fake)[0].body), { name: "kb" });
    assert.strictEqual(posts(fake)[0].authorization, `Bearer ${TOKEN}`);
    assert.strictEqual(fake.requests.filter((r) => r.method === "GET").length, 0);
    // An empty repo is not in the listing until its first push.
    assert.ok(!(await market.list()).some((r) => r.name === "kb"));
  });
});

test("create sends description, website and topics when given, and an empty string stays an empty string", async () => {
  await withMarket(async ({ fake, market }) => {
    fake.grantToken(TOKEN, ["registry:read", "registry:push"]);
    const made = await market.create({
      name: "kb",
      description: "",
      website: "https://example.com/kb",
      topics: ["kb", "react"],
    });
    assert.deepStrictEqual(JSON.parse(posts(fake)[0].body), {
      name: "kb",
      description: "",
      website: "https://example.com/kb",
      topics: ["kb", "react"],
    });
    assert.strictEqual(made.repo.description, "");
    await market.create({ name: "kb2", description: "Knowledge base", topics: [] });
    assert.deepStrictEqual(JSON.parse(posts(fake)[1].body), { name: "kb2", description: "Knowledge base", topics: [] });
  });
});

test("create never sends an undefined member as null", async () => {
  await withMarket(async ({ fake, market }) => {
    fake.grantToken(TOKEN, ["registry:read", "registry:push"]);
    await market.create({ name: "kb", description: undefined, website: undefined, topics: undefined });
    const sent = JSON.parse(posts(fake)[0].body);
    assert.deepStrictEqual(Object.keys(sent), ["name"]);
    assert.ok(!posts(fake)[0].body.includes("null"));
  });
});

test("create of an existing empty repo is adopted: 200 surfaces as created === false", async () => {
  await withMarket(async ({ fake, market }) => {
    fake.grantToken(TOKEN, ["registry:read", "registry:push"]);
    assert.strictEqual((await market.create({ name: "kb" })).created, true);
    const again = await market.create({ name: "kb", description: "second try" });
    assert.strictEqual(again.created, false);
    assert.strictEqual(again.repo.description, "second try");
  });
});

test("create of a repo that has history is GatewayRepoExistsError (409 repo-exists, a GatewayConflictError)", async () => {
  await withMarket(async ({ fake, market }) => {
    fake.grantToken(TOKEN, ["registry:read", "registry:push"]);
    const error = await rejectsWith(market.create({ name: "core" }), Err.GatewayRepoExistsError);
    assert.ok(error instanceof Err.GatewayConflictError);
    assert.strictEqual(error.status, 409);
    assert.strictEqual(error.code, "repo-exists");
  });
});

test("create maps every gateway failure to its own typed error", async () => {
  await withMarket(async ({ fake, market }) => {
    fake.grantToken(TOKEN, ["registry:read", "registry:push"]);
    const fail = async (failure, type) => {
      fake.failNext({ method: "POST", ...failure });
      return rejectsWith(market.create({ name: "kb" }), type);
    };
    const busy = await fail({ status: 409, body: { error: "rewrite-in-progress" } }, Err.GatewayRewriteInProgressError);
    assert.ok(busy instanceof Err.GatewayConflictError);
    assert.strictEqual(busy.code, "rewrite-in-progress");
    const scope = await fail(
      { status: 403, body: { error: "scope-missing", scope: "registry:push" } },
      Err.GatewayScopeError
    );
    assert.strictEqual(scope.scope, "registry:push");
    const notSuper = await fail({ status: 403, body: { error: "not-permitted" } }, Err.GatewayNotPermittedError);
    assert.ok(!(notSuper instanceof Err.GatewayScopeError));
    assert.strictEqual(notSuper.code, "not-permitted");
    await fail({ status: 400, body: { error: "invalid-request" } }, Err.GatewayInvalidRequestError);
    await fail({ status: 413, body: { error: "too-large" } }, Err.GatewayTooLargeError);
    const forge = await fail({ status: 502, body: { error: "forge-unavailable" } }, Err.GatewayForgeUnavailableError);
    assert.ok(forge instanceof Err.GatewayUnavailableError);
    assert.strictEqual(forge.status, 502);
    assert.strictEqual(forge.code, "forge-unavailable");
    const registry = await fail({ status: 503, body: { error: "registry-unavailable" } }, Err.GatewayUnavailableError);
    assert.ok(!(registry instanceof Err.GatewayForgeUnavailableError));
    await fail({ status: 401, body: { error: "token-invalid" } }, Err.GatewayAuthError);
  });
});

test("create without registry:push is GatewayScopeError from the fake's scope check", async () => {
  await withMarket(async ({ market }) => {
    const error = await rejectsWith(market.create({ name: "kb" }), Err.GatewayScopeError);
    assert.strictEqual(error.scope, "registry:push");
  });
});

test("create refuses what the gateway would refuse, before sending", async () => {
  await withMarket(async ({ fake, market }) => {
    fake.grantToken(TOKEN, ["registry:read", "registry:push"]);
    const refuse = (request) => rejectsWith(market.create(request), Err.GatewayInvalidArgumentError);
    for (const name of [
      "",
      "KB",
      "-kb",
      "kb-",
      "k b",
      "a..b",
      "kb.git",
      "kb.wiki",
      "kb.rss",
      "kb.atom",
      ".",
      "..",
      "-",
      "x.WIKI",
      "KB.GIT",
      "a/b",
      "x".repeat(101),
      "k​b",
    ]) {
      await refuse({ name });
    }
    await refuse({});
    await refuse({ name: "kb", description: "x".repeat(2049) });
    await refuse({ name: "kb", description: "bell\u0007" });
    await refuse({ name: "kb", description: null });
    await refuse({ name: "kb", website: "ftp://example.com" });
    await refuse({ name: "kb", website: "example.com" });
    await refuse({ name: "kb", website: "https://exa mple.com" });
    await refuse({ name: "kb", website: "https://example.com/é" });
    await refuse({ name: "kb", website: `https://example.com/${"a".repeat(1010)}` });
    await refuse({ name: "kb", website: null });
    await refuse({ name: "kb", topics: ["Upper"] });
    await refuse({ name: "kb", topics: ["-lead"] });
    await refuse({ name: "kb", topics: ["a", "a"] });
    await refuse({ name: "kb", topics: ["x".repeat(36)] });
    await refuse({ name: "kb", topics: Array.from({ length: 26 }, (_, i) => `t${i}`) });
    await refuse({ name: "kb", topics: "kb" });
    await refuse({ name: "kb", topics: [1] });
    await refuse({ name: "kb", topics: null });
    assert.strictEqual(posts(fake).length, 0, "nothing was sent");
  });
});

test("create accepts the edges the gateway accepts", async () => {
  await withMarket(async ({ fake, market }) => {
    fake.grantToken(TOKEN, ["registry:read", "registry:push"]);
    await market.create({
      name: "a",
    });
    await market.create({ name: "x".repeat(100) });
    await market.create({
      name: "a.b_c-d",
      description: "tab\tcr\r\nlf" + "y".repeat(2037),
      topics: ["a.b-c", "x".repeat(35)],
    });
    await market.create({ name: "web1", website: "http://localhost:8080/p" });
    await market.create({ name: "web2", website: "" });
    await market.create({ name: "many", topics: Array.from({ length: 25 }, (_, i) => `t${i}`) });
    assert.strictEqual(posts(fake).length, 6);
  });
});

test("create accepts near-misses of the forge's reserved names", async () => {
  await withMarket(async ({ fake, market }) => {
    fake.grantToken(TOKEN, ["registry:read", "registry:push"]);
    for (const name of ["wiki", "kb-wiki", "kb.wiki.docs", "kb.rss2", "git", "atom", "my.gitx"]) {
      assert.strictEqual((await market.create({ name })).created, true, name);
    }
  });
});

test("the fake refuses the reserved names with 400 like the gateway", async () => {
  await withMarket(async ({ fake, client }) => {
    fake.grantToken(TOKEN, ["registry:read", "registry:push"]);
    for (const name of ["kb.wiki", "kb.rss", "kb.atom", "kb.git", "-", "a..b"]) {
      await rejectsWith(
        client.request("POST", "/api/v1/registry/repos", { body: { name } }),
        Err.GatewayInvalidRequestError
      );
    }
  });
});

test("create refuses an answer that is not the repo asked for", async () => {
  await withMarket(async ({ fake, market }) => {
    fake.grantToken(TOKEN, ["registry:read", "registry:push"]);
    fake.route({
      method: "POST",
      prefix: "/api/v1/registry/repos",
      handler: (req, res) => {
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ name: "other", description: "", defaultBranch: "main", tags: [], gitUrl: "https://g/x.git" })
        );
      },
    });
    await rejectsWith(market.create({ name: "kb" }), Err.GatewayUnexpectedResponseError);
  });
});

// ── repo lifecycle: get, edit, archive, unarchive, rename, delete, tombstones, purge ──

const REPOS = "/api/v1/registry/repos";
const TOMBSTONES = "/api/v1/registry/tombstones";
const sent = (fake, method, p) => fake.requests.filter((r) => r.method === method && r.path === p);
const withPush = (fn) =>
  withMarket(async (ctx) => {
    ctx.fake.grantToken(TOKEN, ["registry:read", "registry:push"]);
    await fn(ctx);
  });

test("the repo view carries website, topics and archived in list, get and create", async () => {
  await withPush(async ({ fake, market }) => {
    fake.repos = [{ ...fake.repos[0], website: "https://example.com/core", topics: ["a", "b"], archived: true }];
    const [listed] = await market.list();
    assert.strictEqual(listed.website, "https://example.com/core");
    assert.deepStrictEqual(listed.topics, ["a", "b"]);
    assert.strictEqual(listed.archived, true);
    assert.deepStrictEqual(await market.get("core"), listed);
    const made = await market.create({ name: "kb", website: "https://example.com/kb", topics: ["kb"] });
    assert.strictEqual(made.repo.website, "https://example.com/kb");
    assert.deepStrictEqual(made.repo.topics, ["kb"]);
    assert.strictEqual(made.repo.archived, false);
  });
});

test("a gateway that sends none of the new members gets the defaults; a wrong shape is malformed", async () => {
  await withPush(async ({ fake, market }) => {
    const [core] = fake.repos;
    assert.strictEqual(core.website, undefined);
    const listed = (await market.list())[0];
    assert.strictEqual(listed.website, "");
    assert.deepStrictEqual(listed.topics, []);
    assert.strictEqual(listed.archived, false);
    for (const bad of [{ website: 7 }, { topics: "x" }, { topics: [1] }, { archived: "yes" }, { archived: null }]) {
      fake.repos = [{ ...core, ...bad }, fake.repos[1]];
      assert.deepStrictEqual(
        (await market.list()).map((r) => r.name),
        ["extras"],
        JSON.stringify(bad)
      );
      await rejectsWith(market.get("core"), Err.GatewayUnexpectedResponseError);
    }
  });
});

test("get finds an empty repo that the listing does not show, and a name the gateway cannot hold is not found unsent", async () => {
  await withPush(async ({ fake, market }) => {
    await market.create({ name: "kb" });
    assert.ok(!(await market.list()).some((r) => r.name === "kb"));
    assert.strictEqual((await market.get("kb")).name, "kb");
    fake.requests.length = 0;
    for (const bad of ["KB", "a/b", "..", "kb.git", "kb.wiki", "", "-", "_deleted-1-kb"]) {
      await rejectsWith(market.get(bad), Err.GatewayNotFoundError);
    }
    assert.strictEqual(fake.requests.length, 0);
  });
});

test("get refuses an answer for another repo", async () => {
  await withPush(async ({ fake, market }) => {
    fake.repos = [{ ...fake.repos[0], name: "other" }];
    fake.route({
      method: "GET",
      prefix: "/api/v1/registry/repos/core",
      handler: (req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(fake.repos[0]));
      },
    });
    await rejectsWith(market.get("core"), Err.GatewayUnexpectedResponseError);
  });
});

test("edit PATCHes only the members given and answers the repo the forge holds", async () => {
  await withPush(async ({ fake, market }) => {
    const edited = await market.edit("core", { description: "new", topics: ["x"], website: undefined });
    assert.deepStrictEqual(JSON.parse(sent(fake, "PATCH", `${REPOS}/core`)[0].body), {
      description: "new",
      topics: ["x"],
    });
    assert.strictEqual(sent(fake, "PATCH", `${REPOS}/core`)[0].authorization, `Bearer ${TOKEN}`);
    assert.strictEqual(edited.description, "new");
    assert.deepStrictEqual(edited.topics, ["x"]);
    assert.strictEqual(edited.website, "");
    assert.strictEqual((await market.get("core")).description, "new");
    await market.edit("core", { website: "", description: "" });
    assert.deepStrictEqual(JSON.parse(sent(fake, "PATCH", `${REPOS}/core`)[1].body), { website: "", description: "" });
  });
});

test("edit refuses what the gateway would refuse, before sending", async () => {
  await withPush(async ({ fake, market }) => {
    const refuse = (name, change) => rejectsWith(market.edit(name, change), Err.GatewayInvalidArgumentError);
    await refuse("core", {});
    await refuse("core", { description: undefined });
    await refuse("core", { name: "other" });
    await refuse("core", { archived: true });
    await refuse("core", { description: 7 });
    await refuse("core", { website: "ftp://x" });
    await refuse("core", { topics: ["A"] });
    await refuse("core", { topics: ["a", "a"] });
    await refuse("core", null);
    await refuse("core", ["x"]);
    await refuse("Core", { description: "x" });
    await refuse("a/b", { description: "x" });
    await refuse("core.git", { description: "x" });
    assert.strictEqual(fake.requests.length, 0);
    // an undefined unknown member is left out, as every undefined member is
    await market.edit("core", { description: "ok", archived: undefined });
    assert.deepStrictEqual(JSON.parse(sent(fake, "PATCH", `${REPOS}/core`)[0].body), { description: "ok" });
  });
});

test("archive and unarchive POST without a body and answer the repo; repeating either is fine", async () => {
  await withPush(async ({ fake, market }) => {
    const archived = await market.archive("core");
    assert.strictEqual(archived.archived, true);
    assert.strictEqual(sent(fake, "POST", `${REPOS}/core/archive`)[0].body, "");
    assert.strictEqual((await market.archive("core")).archived, true);
    assert.strictEqual((await market.get("core")).archived, true);
    const back = await market.unarchive("core");
    assert.strictEqual(back.archived, false);
    assert.strictEqual(sent(fake, "POST", `${REPOS}/core/unarchive`).length, 1);
    assert.strictEqual((await market.unarchive("core")).archived, false);
    await rejectsWith(market.archive("nope"), Err.GatewayNotFoundError);
    await rejectsWith(market.unarchive("nope"), Err.GatewayNotFoundError);
    for (const bad of ["Core", "../core", "core.rss", ""]) {
      await rejectsWith(market.archive(bad), Err.GatewayInvalidArgumentError);
      await rejectsWith(market.unarchive(bad), Err.GatewayInvalidArgumentError);
    }
    assert.strictEqual(fake.requests.filter((r) => r.path.includes("%") || r.path.includes("..")).length, 0);
  });
});

test("an archived repo refuses edit and rename as GatewayRepoArchivedError (409 repo-archived)", async () => {
  await withPush(async ({ market }) => {
    await market.archive("core");
    for (const call of [market.edit("core", { description: "x" }), market.rename("core", "core2")]) {
      const error = await rejectsWith(call, Err.GatewayRepoArchivedError);
      assert.ok(error instanceof Err.GatewayConflictError);
      assert.strictEqual(error.status, 409);
      assert.strictEqual(error.code, "repo-archived");
      assert.match(error.message, /unarchive/);
    }
    // delete and unarchive still work
    assert.strictEqual((await market.unarchive("core")).archived, false);
  });
});

test("rename POSTs the new name, answers the repo at it, and the old name is gone", async () => {
  await withPush(async ({ fake, market }) => {
    const renamed = await market.rename("core", "core-two");
    assert.deepStrictEqual(JSON.parse(sent(fake, "POST", `${REPOS}/core/rename`)[0].body), { name: "core-two" });
    assert.strictEqual(renamed.name, "core-two");
    assert.strictEqual(renamed.gitUrl, fake.gitUrl("marketplace", "core-two"));
    assert.deepStrictEqual(renamed.tags, ["v1", "v2"]);
    await rejectsWith(market.get("core"), Err.GatewayNotFoundError);
    assert.strictEqual((await market.get("core-two")).name, "core-two");
    await rejectsWith(market.rename("core", "core-three"), Err.GatewayNotFoundError);
    const taken = await rejectsWith(market.rename("core-two", "extras"), Err.GatewayRepoExistsError);
    assert.strictEqual(taken.code, "repo-exists");
  });
});

test("rename refuses a bad new name, the same name or a bad old name before sending", async () => {
  await withPush(async ({ fake, market }) => {
    const refuse = (a, b) => rejectsWith(market.rename(a, b), Err.GatewayInvalidArgumentError);
    for (const bad of [
      "Core2",
      "a..b",
      "x.git",
      "X.WIKI",
      "a.rss",
      "a.atom",
      ".",
      "..",
      "-",
      "",
      "a/b",
      "x".repeat(101),
    ]) {
      await refuse("core", bad);
    }
    await refuse("core", "core");
    await refuse("Core", "core2");
    await refuse("core", undefined);
    assert.strictEqual(fake.requests.length, 0);
    // near-misses of the reserved names are fine
    await market.rename("core", "kb.wiki.docs");
    await market.rename("extras", "wiki");
  });
});

test("rename refuses an answer that is not the repo at the new name", async () => {
  await withPush(async ({ fake, market }) => {
    fake.route({
      method: "POST",
      prefix: "/api/v1/registry/repos/core/rename",
      handler: (req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(fake.repos[0]));
      },
    });
    await rejectsWith(market.rename("core", "core-two"), Err.GatewayUnexpectedResponseError);
  });
});

test("delete answers the tombstone's name, the name is free again, and tombstones() lists it", async () => {
  await withPush(async ({ fake, market }) => {
    const tombstone = await market.delete("core");
    assert.strictEqual(typeof tombstone, "string");
    assert.match(tombstone, /^_deleted-[1-9][0-9]*-core$/);
    assert.strictEqual(sent(fake, "DELETE", `${REPOS}/core`).length, 1);
    assert.strictEqual(sent(fake, "DELETE", `${REPOS}/core`)[0].body, "");
    await rejectsWith(market.get("core"), Err.GatewayNotFoundError);
    assert.ok(!(await market.list()).some((r) => r.name === "core"));
    const [listed, ...rest] = await market.tombstones();
    assert.strictEqual(rest.length, 0);
    assert.deepStrictEqual(listed, {
      tombstone,
      deletedName: "core",
      id: Number(tombstone.split("-")[1]),
      archived: true,
    });
    assert.strictEqual((await market.create({ name: "core" })).created, true);
    await rejectsWith(market.delete("nope"), Err.GatewayNotFoundError);
    await rejectsWith(market.delete("Core"), Err.GatewayInvalidArgumentError);
    // an archived repo can be deleted, an empty one too
    await market.archive("extras");
    assert.match(await market.delete("extras"), /^_deleted-\d+-extras$/);
    assert.match(await market.delete("core"), /^_deleted-\d+-core$/);
  });
});

test("delete refuses an answer that names no tombstone of the repo", async () => {
  const answer = (body) =>
    withPush(async ({ fake, market }) => {
      fake.route({
        method: "DELETE",
        prefix: "/api/v1/registry/repos/core",
        handler: (req, res) => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(body));
        },
      });
      await rejectsWith(market.delete("core"), Err.GatewayUnexpectedResponseError);
    });
  await answer({ name: "core", tombstone: "core" });
  await answer({ name: "extras", tombstone: "_deleted-4-extras" });
  await answer({ name: "core" });
  await answer([]);
});

test("tombstones leaves out a malformed entry and refuses a body that is not a list", async () => {
  const good = { tombstone: "_deleted-42-kb", deletedName: "kb", id: 42, archived: true };
  const listed = async (body) => {
    let result;
    await withPush(async ({ fake, market }) => {
      fake.route({
        method: "GET",
        prefix: TOMBSTONES,
        handler: (req, res) => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(body));
        },
      });
      result = await market.tombstones().then(
        (found) => found,
        (error) => error
      );
    });
    return result;
  };
  assert.deepStrictEqual(
    await listed({
      tombstones: [
        good,
        { ...good, tombstone: "kb" },
        { ...good, id: "42" },
        { ...good, id: 0 },
        { ...good, archived: 1 },
        { ...good, deletedName: 3 },
        "x",
      ],
    }),
    [good]
  );
  assert.deepStrictEqual(await listed({ tombstones: [] }), []);
  const bad = await listed({ nope: [] });
  thrownMessages.push(bad.message);
  assert.ok(bad instanceof Err.GatewayUnexpectedResponseError);
});

test("purge DELETEs the tombstone, which is then gone; the marketplace name rule does not apply to it", async () => {
  await withPush(async ({ fake, market }) => {
    const tombstone = await market.delete("core");
    assert.strictEqual(await market.purge(tombstone), undefined);
    assert.strictEqual(sent(fake, "DELETE", `${TOMBSTONES}/${tombstone}`).length, 1);
    assert.deepStrictEqual(await market.tombstones(), []);
    await rejectsWith(market.purge(tombstone), Err.GatewayNotFoundError);
    // the tombstone rule: a long name cut to 100 characters is still a tombstone
    const long = `_deleted-7-${"a".repeat(89)}`;
    assert.strictEqual(long.length, 100);
    fake.tombstones.set(long, { tombstone: long, deletedName: "a".repeat(89), id: 7, archived: true });
    await market.purge(long);
  });
});

test("purge refuses what is not a tombstone name before sending", async () => {
  await withPush(async ({ fake, market }) => {
    for (const bad of [
      "kb",
      "core",
      "_deleted-kb",
      "_deleted--kb",
      "_deleted-0-kb",
      "_deleted-01-kb",
      "_deleted-1-KB",
      "_deleted-1-",
      "_deleted-1-a..b",
      "_deleted-1-a/b",
      "../_deleted-1-kb",
      `_deleted-1-${"a".repeat(90)}`,
      "_Deleted-1-kb",
      "",
      undefined,
    ]) {
      await rejectsWith(market.purge(bad), Err.GatewayInvalidArgumentError);
    }
    assert.strictEqual(fake.requests.length, 0);
  });
});

test("a purge of an unarchived tombstone is GatewayNotArchivedError (409 not-archived)", async () => {
  await withPush(async ({ fake, market }) => {
    const tombstone = await market.delete("core");
    fake.tombstones.get(tombstone).archived = false;
    const error = await rejectsWith(market.purge(tombstone), Err.GatewayNotArchivedError);
    assert.ok(error instanceof Err.GatewayConflictError);
    assert.strictEqual(error.code, "not-archived");
    assert.strictEqual((await market.tombstones()).length, 1);
  });
});

test("a purge without the history-manager grant is GatewayNotPermittedError whose message says so", async () => {
  await withPush(async ({ fake, market }) => {
    const tombstone = await market.delete("core");
    fake.historyManager = false;
    const error = await rejectsWith(market.purge(tombstone), Err.GatewayNotPermittedError);
    assert.strictEqual(error.status, 403);
    assert.strictEqual(error.code, "not-permitted");
    assert.match(error.message, /history-manager grant/);
    assert.strictEqual((await market.tombstones()).length, 1, "nothing was purged");
    // an ordinary write is not affected, and its message does not claim the grant
    const other = await rejectsWith(
      (fake.failNext({ method: "POST", status: 403, body: { error: "not-permitted" } }), market.archive("core")),
      Err.GatewayNotPermittedError
    );
    assert.ok(!/history-manager/.test(other.message));
  });
});

test("the lifecycle routes need registry:push, and get only registry:read", async () => {
  await withMarket(async ({ fake, market }) => {
    assert.strictEqual((await market.get("core")).name, "core");
    const calls = [
      () => market.edit("core", { description: "x" }),
      () => market.archive("core"),
      () => market.unarchive("core"),
      () => market.rename("core", "core2"),
      () => market.delete("core"),
      () => market.tombstones(),
      () => market.purge("_deleted-1-core"),
    ];
    for (const call of calls) {
      const error = await rejectsWith(call(), Err.GatewayScopeError);
      assert.strictEqual(error.scope, "registry:push");
    }
    fake.grantToken(TOKEN, ["registry:push"]);
    const read = await rejectsWith(market.get("core"), Err.GatewayScopeError);
    assert.strictEqual(read.scope, "registry:read");
  });
});

test("every lifecycle call maps every gateway failure to its typed error", async () => {
  await withPush(async ({ fake, market }) => {
    const calls = [
      ["GET", () => market.get("core")],
      ["PATCH", () => market.edit("core", { description: "x" })],
      ["POST", () => market.archive("core")],
      ["POST", () => market.unarchive("core")],
      ["POST", () => market.rename("core", "core2")],
      ["DELETE", () => market.delete("core")],
      ["GET", () => market.tombstones()],
      ["DELETE", () => market.purge("_deleted-1-core")],
    ];
    const failures = [
      [{ status: 400, body: { error: "invalid-request" } }, Err.GatewayInvalidRequestError, "invalid-request"],
      [{ status: 401, body: { error: "token-invalid" } }, Err.GatewayAuthError, "token-invalid"],
      [
        { status: 403, body: { error: "scope-missing", scope: "registry:push" } },
        Err.GatewayScopeError,
        "scope-missing",
      ],
      [{ status: 403, body: { error: "not-permitted" } }, Err.GatewayNotPermittedError, "not-permitted"],
      [{ status: 404, body: { error: "not-found" } }, Err.GatewayNotFoundError, "not-found"],
      [{ status: 409, body: { error: "repo-archived" } }, Err.GatewayRepoArchivedError, "repo-archived"],
      [{ status: 409, body: { error: "not-archived" } }, Err.GatewayNotArchivedError, "not-archived"],
      [{ status: 409, body: { error: "repo-exists" } }, Err.GatewayRepoExistsError, "repo-exists"],
      [
        { status: 409, body: { error: "rewrite-in-progress" } },
        Err.GatewayRewriteInProgressError,
        "rewrite-in-progress",
      ],
      [{ status: 413, body: { error: "too-large" } }, Err.GatewayTooLargeError, "too-large"],
      [{ status: 502, body: { error: "forge-unavailable" } }, Err.GatewayForgeUnavailableError, "forge-unavailable"],
      [{ status: 503, body: { error: "registry-unavailable" } }, Err.GatewayUnavailableError, "registry-unavailable"],
    ];
    for (const [method, call] of calls) {
      for (const [failure, type, code] of failures) {
        fake.failNext({ method, ...failure });
        const error = await rejectsWith(call(), type);
        assert.strictEqual(error.code, code);
        assert.strictEqual(error.status, failure.status);
      }
    }
  });
});

test("a repo-archived push through the git layer is the same typed error", async () => {
  const { gatewayErrorFor } = require("../dist/gateway/GatewayClient.js");
  const error = gatewayErrorFor(409, '{"error":"repo-archived","message":"archived"}', "POST x");
  assert.ok(error instanceof Err.GatewayRepoArchivedError);
  thrownMessages.push(error.message);
});

test("lifecycle answers that are not the contract's are GatewayUnexpectedResponseError", async () => {
  for (const body of ["null", "[]", '{"name":"core"}', '{"name":7}']) {
    await withPush(async ({ fake, market }) => {
      fake.route({
        method: "POST",
        prefix: "/api/v1/registry/repos/core/archive",
        handler: (req, res) => {
          res.setHeader("content-type", "application/json");
          res.end(body);
        },
      });
      await rejectsWith(market.archive("core"), Err.GatewayUnexpectedResponseError);
    });
  }
});

test("the fake refuses what the gateway refuses on the lifecycle routes", async () => {
  await withPush(async ({ fake, client }) => {
    const call = (method, p, body) =>
      client.requestDetailed(method, p, body === undefined ? {} : { body }).then(
        (a) => a.status,
        (e) => e.status
      );
    assert.strictEqual(await call("PATCH", `${REPOS}/core`, {}), 400);
    assert.strictEqual(await call("PATCH", `${REPOS}/core`, { archived: true }), 400);
    assert.strictEqual(await call("POST", `${REPOS}/core/rename`, { name: "core" }), 400);
    assert.strictEqual(await call("POST", `${REPOS}/core/rename`, { name: "X" }), 400);
    assert.strictEqual(await call("GET", `${REPOS}/Core`), 404);
    assert.strictEqual(await call("GET", `${REPOS}/nope`), 404);
    assert.strictEqual(await call("DELETE", `${TOMBSTONES}/nope`), 404);
    assert.strictEqual(await call("GET", `${REPOS}/core/archive`), 404);
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
