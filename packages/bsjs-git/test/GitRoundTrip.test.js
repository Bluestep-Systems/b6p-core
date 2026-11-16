// Behavioral spec for ScriptRepo against a local bare repo served over smart HTTP by a stand-in for the platform's
// git proxy (support/GitProxyStub.js): clone -> edit -> commit -> push -> publish -> history -> diff, plus the
// proxy's refusals mapped to typed errors. Dependency-free node script (run via `npm test`) over the COMPILED dist/.

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStub } = require("./support/GitProxyStub");
const lib = require("../dist/index.js");

const AUTHOR = { name: "Ada Tester", email: "ada@example.test" };
const REPO = "654015___1001";

let failures = 0;
const pending = [];
function test(name, fn) {
  pending.push([name, fn]);
}

async function rejects(promise, type, check) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof type, `expected ${type.name}, got ${error && error.name}: ${error && error.message}`);
    if (check) {
      check(error);
    }
    return error;
  }
  assert.fail(`expected ${type.name}, but the call succeeded`);
}

const stub = createStub();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bsjs-git-work-"));
let baseUrl;
let n = 0;

function repoFor(script, { token = stub.TOKEN, author = AUTHOR, auth, fetch } = {}) {
  const dir = path.join(tmp, `wt${++n}`);
  fs.mkdirSync(dir);
  return new lib.ScriptRepo({ fs, dir, script, baseUrl, auth: auth ?? { kind: "token", token }, author, fetch });
}
const key = (id) => lib.parseCompoundId(id);

test("clone, edit, commit, push, publish, history and diff round trip", async () => {
  const repo = repoFor(key(REPO));
  await repo.clone();
  assert.strictEqual(fs.readFileSync(path.join(repo.dir, "main.ts"), "utf8"), "export const v = 1;\n");
  const seeded = await repo.log();
  assert.strictEqual(seeded.length, 1);
  assert.strictEqual(seeded[0].message, "Seed master");

  assert.strictEqual(await repo.commit("nothing changed"), undefined, "a clean tree commits nothing");

  await repo.writeFile("main.ts", "export const v = 2;\n");
  await repo.writeFile("lib/util.ts", "export const u = 1;\n");
  assert.deepStrictEqual(
    (await repo.status()).sort((a, b) => a.path.localeCompare(b.path)),
    [
      { path: "lib/util.ts", status: "added" },
      { path: "main.ts", status: "modified" },
    ]
  );
  const first = await repo.commit("Edit main, add util");
  assert.match(first, /^[0-9a-f]{40}$/);
  await repo.removeFile("lib/util.ts");
  const second = await repo.commit("Drop util");
  assert.ok(second && second !== first);

  const pushed = await repo.push();
  assert.deepStrictEqual(pushed, { ref: "draft", sha: second });
  assert.strictEqual(stub.git(stub.repos.get(REPO).bare, "rev-parse", "refs/heads/draft"), second);

  const log = await repo.log();
  assert.deepStrictEqual(
    log.map((c) => c.message),
    ["Drop util", "Edit main, add util", "Seed master"]
  );
  assert.deepStrictEqual(log[0].author, AUTHOR, "the commit author is the caller's identity");
  assert.match(log[0].timestamp, /^\d{4}-\d\d-\d\dT/);
  const page = await repo.log({ limit: 1, before: log[0].sha });
  assert.deepStrictEqual(
    page.map((c) => c.sha),
    [log[1].sha],
    "before continues after the cursor"
  );

  const published = await repo.publish();
  assert.deepStrictEqual(published, { publishedSha: second, refreshed: true }, "publish returns the promoted sha");
  assert.ok(stub.state.csrfRequests >= 1, "the publish asked for a CSRF token");
  assert.deepStrictEqual(
    (await repo.log({ rev: "master" })).map((c) => c.sha),
    log.map((c) => c.sha),
    "master now holds the draft's history"
  );

  assert.deepStrictEqual(
    (await repo.listTree(second)).map((f) => f.path),
    ["main.ts"]
  );
  assert.strictEqual(await repo.readText(first, "lib/util.ts"), "export const u = 1;\n");
  assert.strictEqual(await repo.readText("draft", "main.ts"), "export const v = 2;\n");
  const diff = await repo.diff(seeded[0].sha, first);
  assert.deepStrictEqual(
    diff.map((c) => [c.path, c.status]),
    [
      ["lib/util.ts", "added"],
      ["main.ts", "modified"],
    ]
  );
  const gone = await repo.diff(first, second);
  assert.deepStrictEqual(
    gone.map((c) => [c.path, c.status]),
    [["lib/util.ts", "deleted"]]
  );
});

test("a commit needs a caller-supplied author", async () => {
  const repo = repoFor(key(REPO), { author: null });
  await repo.clone();
  await repo.writeFile("a.txt", "a");
  await rejects(repo.commit("no author"), lib.GitIdentityError);
  await rejects(repo.commit("blank", { name: " ", email: "x@y" }), lib.GitIdentityError);
  assert.ok(await repo.commit("with author", AUTHOR));
});

test("publish refuses while the local draft is not pushed", async () => {
  const repo = repoFor(key(REPO));
  await repo.clone();
  await repo.writeFile("unpushed.txt", "x");
  await repo.commit("local only");
  await rejects(repo.publish(), lib.GitUnpushedChangesError);
});

test("a stale clone's push is not a fast-forward; pull fast-forwards", async () => {
  const a = repoFor(key(REPO));
  const b = repoFor(key(REPO));
  await a.clone();
  await b.clone();
  await a.writeFile("a.txt", "from a");
  await a.commit("a's change");
  await a.push();
  await b.writeFile("b.txt", "from b");
  await b.commit("b's change");
  await rejects(b.push(), lib.GitNotFastForwardError);
  const c = repoFor(key(REPO));
  await c.clone();
  assert.ok(fs.existsSync(path.join(c.dir, "a.txt")));
  await b.fetch();
  await rejects(b.pull(), lib.GitNotFastForwardError);
});

test("a pull brings in the platform's newer draft", async () => {
  const a = repoFor(key(REPO));
  const b = repoFor(key(REPO));
  await a.clone();
  await b.clone();
  await a.writeFile("newer.txt", "n");
  await a.commit("newer");
  await a.push();
  await b.pull();
  assert.ok(fs.existsSync(path.join(b.dir, "newer.txt")));
});

test("refusals map to typed errors", async () => {
  await rejects(repoFor(key(REPO), { token: "b6pt_wrong" }).clone(), lib.GitAuthError);
  await rejects(repoFor(key("654015___9999")).clone(), lib.GitRepoNotFoundError);

  stub.addRepo("654015___2002", { mode: "WEBDAV" });
  const webdav = repoFor(key("654015___2002"));
  await webdav.clone();
  await webdav.writeFile("x.txt", "x");
  await webdav.commit("x");
  const notEnabled = await rejects(webdav.push(), lib.GitPushNotEnabledError);
  assert.ok(notEnabled instanceof lib.GitPermissionError);
  assert.match(notEnabled.reason, /publishMode=WEBDAV/);
  assert.strictEqual(notEnabled.code, "PUSH_NOT_ENABLED");

  stub.addRepo("654015___3003", { locked: true });
  const locked = repoFor(key("654015___3003"));
  await locked.clone();
  await locked.writeFile("x.txt", "x");
  await locked.commit("x");
  await rejects(locked.push(), lib.GitCodeLockedError);
});

test("a proxied push to the published branch is rejected as protected", async () => {
  const repo = repoFor(key(REPO));
  await repo.clone();
  await repo.writeFile("m.txt", "m");
  await repo.commit("to master?");
  await repo.checkout("master");
  await rejects(repo.push("master", true), lib.GitPushRejectedError, (error) => {
    assert.strictEqual(error.protectedBranch, true);
    assert.strictEqual(error.ref, "master");
  });
});

test("a refused publish keeps the server's reason", async () => {
  stub.addRepo("654015___4004");
  stub.repos.get("654015___4004").refusePublish = "ENTRYPOINT_MISSING";
  const repo = repoFor(key("654015___4004"));
  await repo.clone();
  await rejects(repo.publish(), lib.PublishRefusedError, (error) => {
    assert.strictEqual(error.reason, "ENTRYPOINT_MISSING");
    assert.deepStrictEqual(error.details, { entrypoint: "main.js" });
  });
});

test("a script type with no publish mutation is refused", async () => {
  const repo = repoFor({ classid: "111111", seqnum: "1" });
  assert.throws(() => lib.publishMutationFor(repo.script), lib.UnknownScriptTypeError);
});

test("a transport failure is typed", async () => {
  const dir = path.join(tmp, `wt${++n}`);
  fs.mkdirSync(dir);
  const repo = new lib.ScriptRepo({
    fs,
    dir,
    script: key(REPO),
    baseUrl: "http://127.0.0.1:1/",
    auth: { kind: "token", token: stub.TOKEN },
    author: AUTHOR,
  });
  await rejects(repo.clone(), lib.GitTransportError);
});

test("publish carries the CSRF token and session; a refused token is retried once", async () => {
  const repo = repoFor(key(REPO));
  await repo.clone();
  const before = stub.state.gqlRequests;
  stub.state.rejectNextCsrf = true;
  const result = await repo.publish();
  assert.match(result.publishedSha, /^[0-9a-f]{40}$/);
  assert.strictEqual(stub.state.gqlRequests - before, 2, "one refused attempt, one retry");
  // A request without the header or the cookie is refused by the stub, so the success above proves both were sent.
});

test("a failed post-publish refresh still reports the publish", async () => {
  stub.addRepo("654015___5005");
  stub.repos.get("654015___5005").failFetchAfterPublish = true;
  const repo = repoFor(key("654015___5005"));
  await repo.clone();
  const result = await repo.publish();
  stub.state.failGitAfterPublish = false;
  assert.strictEqual(result.refreshed, false);
  assert.ok(result.refreshError instanceof lib.GitServerError);
  assert.strictEqual(
    result.publishedSha,
    stub.git(stub.repos.get("654015___5005").bare, "rev-parse", "refs/heads/master")
  );
});

test("paths with a backslash, a dot-dot or a .git segment are refused", async () => {
  const repo = repoFor(key(REPO));
  await repo.clone();
  for (const bad of ["a\\b.txt", "..\\x", "../x", ".git/config", "a/../../x"]) {
    await assert.rejects(repo.writeFile(bad, "x"), /Not a path/);
    await assert.rejects(repo.removeFile(bad), /Not a path/);
    await assert.rejects(repo.readFile("draft", bad), /Not a path/);
  }
});

test("log pages across a merge without losing the other parent", async () => {
  const name = "654015___6006";
  const bare = stub.addRepo(name);
  const work = path.join(tmp, "merge-work");
  const at = (t) => ({
    GIT_AUTHOR_DATE: `${t} +0000`,
    GIT_COMMITTER_DATE: `${t} +0000`,
    GIT_AUTHOR_NAME: "M",
    GIT_AUTHOR_EMAIL: "m@example.test",
    GIT_COMMITTER_NAME: "M",
    GIT_COMMITTER_EMAIL: "m@example.test",
  });
  const g = (t, ...args) => stub.gitEnv(work, at(t), ...args);
  fs.mkdirSync(work);
  stub.gitEnv(tmp, {}, "clone", "-q", "-b", "draft", bare, work);
  g(1_700_000_100, "commit", "-q", "--allow-empty", "-m", "root");
  g(1_700_000_200, "checkout", "-q", "-b", "side");
  g(1_700_000_300, "commit", "-q", "--allow-empty", "-m", "left");
  g(1_700_000_400, "checkout", "-q", "draft");
  g(1_700_000_500, "commit", "-q", "--allow-empty", "-m", "right");
  g(1_700_000_600, "merge", "-q", "--no-ff", "-m", "merge", "side");
  g(1_700_000_600, "push", "-q", "origin", "draft");
  const repo = repoFor(key(name));
  await repo.clone();
  const all = (await repo.log({ limit: 10 })).map((c) => c.message);
  assert.deepStrictEqual(all.slice(0, 4), ["merge", "right", "left", "root"]);
  const one = await repo.log({ limit: 2 });
  assert.deepStrictEqual(
    one.map((c) => c.message),
    ["merge", "right"]
  );
  const two = await repo.log({ limit: 2, before: one[1].sha });
  assert.deepStrictEqual(
    two.map((c) => c.message),
    ["left", "root"],
    "page 2 keeps the merge's left parent"
  );
});

test("ensureGitMode switches a WEBDAV script once and leaves a GIT script alone", async () => {
  stub.addRepo("654015___7007", { mode: "WEBDAV" });
  const repo = repoFor(key("654015___7007"));
  const enableBefore = stub.state.enableCalls;
  const url = await repo.ensureGitMode();
  assert.strictEqual(url, "https://stub.example.test/git/654015___7007");
  assert.strictEqual(stub.state.enableCalls - enableBefore, 1, "the WEBDAV script was switched");
  assert.strictEqual(stub.repos.get("654015___7007").mode, "GIT");
  assert.strictEqual(stub.state.modeQueries >= 1, true, "the mode was read with a query");
  assert.strictEqual(await repo.ensureGitMode(), url);
  assert.strictEqual(stub.state.enableCalls - enableBefore, 1, "a GIT script gets no enable mutation");
  const already = stub.state.enableCalls;
  await repoFor(key(REPO)).ensureGitMode();
  assert.strictEqual(stub.state.enableCalls, already);
});

test("ensureGitModeResult says whether this call did the switch", async () => {
  stub.addRepo("654015___7108", { mode: "WEBDAV" });
  const repo = repoFor(key("654015___7108"));
  assert.deepStrictEqual(await repo.ensureGitModeResult(), {
    cloneUrl: "https://stub.example.test/git/654015___7108",
    switched: true,
  });
  assert.strictEqual((await repo.ensureGitModeResult()).switched, false);
});

test("sha, isAncestor, a commit with explicit parents, and resetDraft", async () => {
  stub.addRepo("654015___7109");
  const a = repoFor(key("654015___7109"));
  await a.clone();
  const base = await a.sha("draft");
  assert.strictEqual(await a.isAncestor(base, "draft"), true);
  await a.writeFile("a.txt", "a");
  const mine = await a.commit("mine");
  assert.strictEqual(await a.isAncestor(base, mine), true);
  assert.strictEqual(await a.isAncestor(mine, base), false);

  const b = repoFor(key("654015___7109"));
  await b.clone();
  await b.writeFile("b.txt", "b");
  await b.commit("theirs");
  await b.push();
  await a.fetch();
  const theirs = await a.sha("origin/draft");
  assert.strictEqual(await a.isAncestor(mine, theirs), false);
  assert.strictEqual(await a.isAncestor(theirs, mine), false, "diverged");

  // A merge commit over both parents, made with nothing to stage, is a descendant of both and pushes as a fast-forward.
  const merge = await a.commit("merge", AUTHOR, { parents: [mine, theirs] });
  assert.ok(merge);
  assert.strictEqual(await a.isAncestor(theirs, merge), true);
  assert.strictEqual(await a.isAncestor(mine, merge), true);
  await a.push();

  // resetDraft moves the local draft and its working tree to a commit.
  await a.resetDraft(base);
  assert.strictEqual(await a.sha("draft"), base);
  assert.strictEqual(fs.existsSync(path.join(a.dir, "a.txt")), false);
});

test("gitMode reads the mode without switching; currentBranch and stagedOnlyChanges read the working tree", async () => {
  stub.addRepo("654015___7110", { mode: "WEBDAV" });
  const before = stub.state.enableCalls;
  assert.deepStrictEqual(await repoFor(key("654015___7110")).gitMode(), { gitPublishing: false, cloneUrl: null });
  assert.strictEqual(stub.state.enableCalls, before, "a read never switches");
  assert.strictEqual((await repoFor(key(REPO)).gitMode()).gitPublishing, true);

  const repo = repoFor(key(REPO));
  await repo.clone();
  assert.strictEqual(await repo.currentBranch(), "draft");
  await repo.writeFile("staged.txt", "one");
  stub.git(repo.dir, "add", "staged.txt");
  assert.deepStrictEqual(await repo.stagedOnlyChanges(), [], "staged and equal to the file is not index-only");
  await repo.writeFile("staged.txt", "two");
  assert.deepStrictEqual(await repo.stagedOnlyChanges(), ["staged.txt"]);
});

test("publish names the draft it verified (expectedDraftSha); a draft that moved since is a typed refusal", async () => {
  stub.addRepo("654015___7111");
  const repo = repoFor(key("654015___7111"));
  await repo.clone();
  await repo.writeFile("p.txt", "p");
  const sha = await repo.commit("p");
  await repo.push();
  const { publishedSha } = await repo.publish();
  assert.strictEqual(publishedSha, sha);
  assert.strictEqual(stub.state.publishInputs.at(-1).expectedDraftSha, sha);
  assert.match(stub.state.publishInputs.at(-1).expectedDraftSha, /^[0-9a-f]{40}$/, "always the full sha");

  await repo.writeFile("q.txt", "q");
  await repo.commit("q");
  await repo.push();
  const entry = stub.repos.get("654015___7111");
  entry.beforePublish = () => {
    // Someone else pushes to draft between the verification and the publish.
    const env = {
      GIT_AUTHOR_NAME: "X",
      GIT_AUTHOR_EMAIL: "x@example.test",
      GIT_COMMITTER_NAME: "X",
      GIT_COMMITTER_EMAIL: "x@example.test",
    };
    const tree = stub.git(entry.bare, "rev-parse", "draft^{tree}");
    const moved = stub.gitEnv(entry.bare, env, "commit-tree", tree, "-p", "draft", "-m", "moved");
    stub.git(entry.bare, "update-ref", "refs/heads/draft", moved);
    entry.beforePublish = undefined;
  };
  const masterBefore = stub.git(entry.bare, "rev-parse", "master");
  await rejects(repo.publish(), lib.PublishDraftMovedError, (e) => {
    assert.ok(e instanceof lib.PublishRefusedError);
    assert.strictEqual(e.reason, "DRAFT_MOVED");
  });
  assert.strictEqual(stub.git(entry.bare, "rev-parse", "master"), masterBefore, "nothing was published");
});

test("commit({ force }) stages an ignored file the caller names (build output), and only that one", async () => {
  stub.addRepo("654015___7112", { files: { "main.ts": "a\n", ".gitignore": ".build/\nother.log\n" } });
  const repo = repoFor(key("654015___7112"));
  await repo.clone();
  await repo.writeFile(".build/app.js", "built\n");
  await repo.writeFile("other.log", "log\n");
  assert.strictEqual(await repo.commit("nothing visible"), undefined, "ignored files are not staged by default");
  const sha = await repo.commit("build output", AUTHOR, { force: [".build/app.js", "missing.js"] });
  assert.ok(sha);
  await repo.push();
  assert.deepStrictEqual((await repo.listTree("draft")).map((f) => f.path).sort(), [
    ".build/app.js",
    ".gitignore",
    "main.ts",
  ]);
  // Once tracked, an edit to it is an ordinary change.
  await repo.writeFile(".build/app.js", "rebuilt\n");
  assert.ok(await repo.commit("rebuild"));
});

test("a bounded clone: depth, single branch plus master's head, then commit, push, publish; log past the boundary, deepen", async () => {
  stub.addRepo("654015___7113");
  const seed = repoFor(key("654015___7113"));
  await seed.clone();
  for (let i = 1; i <= 6; i++) {
    await seed.writeFile("n.txt", `${i}\n`);
    await seed.commit(`c${i}`);
  }
  await seed.push();

  const repo = repoFor(key("654015___7113"));
  await repo.clone({ depth: 2, singleBranch: true });
  assert.strictEqual(await repo.isShallow(), true);
  assert.ok(await repo.sha("refs/remotes/origin/master"), "master's head came along for the publish markers");
  const first = await repo.logPage({ limit: 10 });
  assert.deepStrictEqual(
    first.commits.map((c) => c.message),
    ["c6", "c5"]
  );
  assert.strictEqual(first.shallowBoundary, true, "fewer than asked for, and the history loaded here ended");

  // Everything else works on the shallow clone.
  await repo.writeFile("m.txt", "m");
  const mine = await repo.commit("shallow commit");
  await repo.push();
  const { publishedSha } = await repo.publish();
  assert.strictEqual(publishedSha, mine);
  assert.strictEqual(await repo.sha("origin/master"), mine);
  assert.strictEqual((await repo.gitMode()).gitPublishing, true);

  // Someone else pushes; the shallow clone sees it, and divergence checks and a fast-forward pull work.
  const other = repoFor(key("654015___7113"));
  await other.clone();
  await other.writeFile("o.txt", "o");
  await other.commit("other");
  await other.push();
  await repo.fetch();
  assert.strictEqual(await repo.isAncestor(mine, "origin/draft"), true);
  await repo.pull();
  assert.strictEqual(fs.existsSync(path.join(repo.dir, "o.txt")), true);

  const beforeDeepen = await repo.logPage({ limit: 50 });
  assert.strictEqual(beforeDeepen.shallowBoundary, true);
  const loaded = beforeDeepen.commits.length;
  await repo.deepen(3);
  const deeper = await repo.logPage({ limit: 50 });
  assert.ok(deeper.commits.length > loaded, "deepen brought older commits");
  await repo.deepen(50);
  const all = await repo.logPage({ limit: 50 });
  assert.strictEqual(all.shallowBoundary, false);
  assert.strictEqual(all.commits.at(-1).message, "Seed master");
  assert.strictEqual(await repo.isShallow(), false);
});
test("clone({ensureGit}) switches a WEBDAV script so its push works; a plain clone does not", async () => {
  stub.addRepo("654015___8008", { mode: "WEBDAV" });
  await repoFor(key("654015___8008")).clone();
  assert.strictEqual(stub.repos.get("654015___8008").mode, "WEBDAV", "a plain clone leaves the mode alone");
  const repo = repoFor(key("654015___8008"));
  await repo.clone({ ensureGit: true });
  assert.strictEqual(stub.repos.get("654015___8008").mode, "GIT");
  await repo.writeFile("x.txt", "x");
  await repo.commit("x");
  await repo.push();
});

test("session mode: clone, commit, push and publish with a cookie and the CSRF header, no Authorization", async () => {
  // A browser's jar sends the session cookie by itself; this fetch plays that part and records any Authorization.
  const seen = [];
  const browserFetch = (url, init) => {
    const headers = { ...init.headers, Cookie: "JSESSIONID=stub-session" };
    seen.push(headers.Authorization);
    return fetch(url, { ...init, headers });
  };
  const repo = repoFor(key(REPO), { auth: { kind: "session" }, fetch: browserFetch });
  const before = stub.state.sessionGitRequests;
  await repo.clone();
  assert.ok(stub.state.sessionGitRequests - before >= 2, "the clone's git requests went through the session lane");
  await repo.writeFile("session.txt", "s");
  const sha = await repo.commit("from a session");
  await repo.push();
  assert.strictEqual(stub.git(stub.repos.get(REPO).bare, "rev-parse", "refs/heads/draft"), sha);
  assert.strictEqual((await repo.publish()).publishedSha, sha);
  assert.ok(
    seen.every((a) => a === undefined),
    "no Authorization header was sent in session mode"
  );
});

test("session mode without the session is refused", async () => {
  await rejects(repoFor(key(REPO), { auth: { kind: "session" } }).clone(), Error);
});

(async () => {
  stub.addRepo(REPO);
  baseUrl = await stub.listen();
  for (const [name, fn] of pending) {
    try {
      await fn();
      console.log(`ok   - ${name}`);
    } catch (e) {
      failures++;
      console.error(`FAIL - ${name}\n       ${e.stack || e.message}`);
    }
  }
  await stub.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll GitRoundTrip tests passed.");
})();
