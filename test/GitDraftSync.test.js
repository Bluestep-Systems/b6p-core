// Behavioral spec for the git-mode script sync (src/script/GitSync.ts, GitIdentity.ts and executePush): pull, push,
// publish and audit of a script's draft folder through the platform's git proxy.
//
// The platform is a stand-in from the bsjs-git package's tests (GitProxyStub): real bare repos served over smart HTTP
// by `git http-backend` on loopback, with the proxy's gates (token auth, WEBDAV-mode scripts read-only) and a publish
// that fast-forwards master to draft. The draft folder is a real temp folder; only the platform is faked. Needs `git`
// on the PATH. Dependency-free node script over the COMPILED dist/ (run via `npm test`).
//
// What this pins:
//  - pull clones into `draft/`, fast-forwards later, keeps a local edit the platform also changed, restores missing files;
//  - a WEBDAV script is switched to git only after a confirmation whose safe answer is the default (what `--yes` gives),
//    and the switch is reported;
//  - push commits the working tree as the resolved author and pushes the draft branch; a snapshot push publishes and
//    reads back that master is at the published sha;
//  - platform edits are never overwritten without the one confirmation, safe option first, and a declined push sends nothing;
//  - a folder from before git (files, no repository) is bound to the repo by a push, and a deploy never binds it;
//  - the commit author comes from the explicit option, then git config, then the environment, else a clear error.

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createStub } = require("../packages/bsjs-git/test/support/GitProxyStub");
const core = require("../dist/index.js");
const { pullDraft, pushDraft, auditDraft, GitSwitchDeclinedError } = require("../dist/script/GitSync.js");
const { resolveGitIdentity } = require("../dist/script/GitIdentity.js");
const { executePush } = require("../dist/script/push.js");
const { Err } = require("../dist/Err.js");

const bsjsGit = core.bsjsGit;
const AUTHOR = { name: "Ada Tester", email: "ada@example.test" };
const SCRIPT = { classid: "654015", seqnum: "1001" };
const REPO = "654015___1001";

let failures = 0;
const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const noop = () => {};
const logger = { debug: noop, info: noop, warn: noop, error: noop };
const firstOption = (options) => options[0];
const pick = (label) => () => label;

/** A Prompt that records confirm() calls and warnings, and answers with `answer(options)` (default: what --yes does). */
function recordingPrompt(answer = firstOption) {
  const calls = [];
  const warnings = [];
  return {
    calls,
    warnings,
    confirm: async (message, options, opts) => {
      calls.push({ message, options, opts });
      return answer(options);
    },
    warn: (message) => warnings.push(message),
    info: noop,
    error: noop,
    popup: async () => {},
    inputBox: async () => undefined,
  };
}

function assertSafeFirst(call, safeOption, destructiveOption) {
  assert.strictEqual(call.opts && call.opts.destructive, true, "destructive must be true");
  assert.strictEqual(call.opts.safeOption, safeOption);
  assert.strictEqual(call.options[0], safeOption, "the safe option must come first");
  assert.ok(call.options.includes(destructiveOption), `"${destructiveOption}" must still be offered`);
}

const stub = createStub();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "b6p-core-git-"));
let baseUrl;
let n = 0;

function fakeCtx(prompt, extra = {}) {
  return {
    gitFs: fs,
    gitToken: async () => stub.TOKEN,
    gitEnv: {},
    prompt,
    logger,
    ...extra,
  };
}

/** A fresh draft folder (not yet created) and the target pointing at it. */
function targetFor(prompt, script = SCRIPT) {
  const draftPath = path.join(tmp, `ws${++n}`, "U100001", "MyScript", "draft");
  return { ctx: fakeCtx(prompt), script, baseUrl, draftPath };
}

const read = (target, rel) => fs.readFileSync(path.join(target.draftPath, ...rel.split("/")), "utf8");
const put = (target, rel, text) => {
  const file = path.join(target.draftPath, ...rel.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const sha512 = (text) => crypto.createHash("sha512").update(Buffer.from(text, "utf8")).digest("hex");
const bare = (name = REPO) => stub.repos.get(name).bare;
const remoteLog = (name = REPO, ref = "draft") => stub.git(bare(name), "log", "--format=%an|%s", ref).split("\n");
const remoteFile = (rel, name = REPO, ref = "draft") => stub.git(bare(name), "show", `${ref}:${rel}`);

/** Another person's clone of the script: pushes `files` to the platform's draft as a separate commit. */
async function platformEdit(files, name = REPO, message = "Edit on the platform") {
  const dir = path.join(tmp, `other${++n}`);
  fs.mkdirSync(dir);
  const [classid, seqnum] = name.split("___");
  const repo = new bsjsGit.ScriptRepo({
    fs,
    dir,
    script: { classid, seqnum },
    baseUrl,
    auth: { kind: "token", token: stub.TOKEN },
    author: { name: "Grace Other", email: "grace@example.test" },
  });
  await repo.clone();
  for (const [rel, text] of Object.entries(files)) {
    if (text === null) {
      await repo.removeFile(rel);
    } else {
      await repo.writeFile(rel, text);
    }
  }
  await repo.commit(message);
  await repo.push();
}

const PUSH = { message: "Edit from the CLI", author: AUTHOR, snapshot: false, adoptUnbound: true };

async function rejects(promise, check) {
  try {
    await promise;
  } catch (error) {
    check(error);
    return error;
  }
  assert.fail("expected the call to fail");
}

// ── pull ──────────────────────────────────────────────────────────────

test("pull into an empty folder clones the draft branch and keeps local-only files out of git", async () => {
  const target = targetFor(recordingPrompt());
  const outcome = await pullDraft(target);
  assert.deepStrictEqual(outcome, { keptLocalPaths: [], switchedToGit: false });
  assert.strictEqual(read(target, "main.ts"), "export const v = 1;\n");
  const exclude = fs.readFileSync(path.join(target.draftPath, ".git", "info", "exclude"), "utf8");
  assert.ok(exclude.includes(".DS_Store") && exclude.includes("*.b6p-tmp"));
});

test("a later pull fast-forwards; a local edit to a file the platform did not touch survives", async () => {
  const target = targetFor(recordingPrompt());
  await pullDraft(target);
  put(target, "notes.md", "mine\n");
  await platformEdit({ "main.ts": "export const v = 2;\n" });
  const outcome = await pullDraft(target);
  assert.deepStrictEqual(outcome.keptLocalPaths, []);
  assert.strictEqual(read(target, "main.ts"), "export const v = 2;\n");
  assert.strictEqual(read(target, "notes.md"), "mine\n");
});

test("a local edit to a file the platform also changed is kept and reported; the platform copy wins when confirmed", async () => {
  const target = targetFor(recordingPrompt());
  await pullDraft(target);
  put(target, "main.ts", "export const v = 'mine';\n");
  await platformEdit({ "main.ts": "export const v = 3;\n", "extra.ts": "export const e = 1;\n" });
  const kept = await pullDraft(target);
  assert.deepStrictEqual(kept.keptLocalPaths, [path.join(target.draftPath, "main.ts")]);
  assert.strictEqual(read(target, "main.ts"), "export const v = 'mine';\n");
  assert.strictEqual(read(target, "extra.ts"), "export const e = 1;\n", "other platform changes still arrive");

  const forced = await pullDraft(target, { overwrite: ["main.ts"] });
  assert.deepStrictEqual(forced.keptLocalPaths, []);
  assert.strictEqual(read(target, "main.ts"), "export const v = 3;\n");
});

test("a file the platform has that is missing locally comes back on pull, and audit reports it", async () => {
  stub.addRepo("654015___1101");
  const target = targetFor(recordingPrompt(), { classid: "654015", seqnum: "1101" });
  await pullDraft(target);
  fs.rmSync(path.join(target.draftPath, "main.ts"));
  put(target, "scratch.ts", "local only\n");
  const audit = await auditDraft(target);
  assert.deepStrictEqual(audit, { missingLocally: ["main.ts"], changed: [] });
  await pullDraft(target);
  assert.strictEqual(read(target, "main.ts"), "export const v = 1;\n");
});

test("audit lists what differs and says nothing about a folder that is not a git working copy yet", async () => {
  const target = targetFor(recordingPrompt());
  assert.strictEqual(await auditDraft(target), undefined);
  await pullDraft(target);
  assert.deepStrictEqual(await auditDraft(target), { missingLocally: [], changed: [] });
  put(target, "main.ts", "export const v = 'changed';\n");
  assert.deepStrictEqual(await auditDraft(target), { missingLocally: [], changed: ["main.ts"] });
});

test("pull of a WEBDAV script: declining the switch (--yes) leaves it alone; confirming switches it, one-way, and says so", async () => {
  stub.addRepo("654015___2001", { mode: "WEBDAV", hidden: true, files: { "app.ts": "export const a = 1;\n" } });
  const script = { classid: "654015", seqnum: "2001" };
  const prompt = recordingPrompt(firstOption);
  const declined = targetFor(prompt, script);
  await rejects(pullDraft(declined), (e) => assert.ok(e instanceof GitSwitchDeclinedError));
  assertSafeFirst(prompt.calls[0], "Cancel", "Switch to git");
  assert.ok(/cannot be undone/.test(prompt.calls[0].message));
  assert.strictEqual(stub.state.enableCalls, 0, "nothing was switched");
  assert.ok(!fs.existsSync(path.join(declined.draftPath, ".git")), "no half-made repository is left behind");

  const confirmedPrompt = recordingPrompt(pick("Switch to git"));
  const confirmed = targetFor(confirmedPrompt, script);
  const outcome = await pullDraft(confirmed);
  assert.strictEqual(outcome.switchedToGit, true);
  assert.strictEqual(read(confirmed, "app.ts"), "export const a = 1;\n");
  assert.strictEqual(stub.state.enableCalls, 1);

  stub.addRepo("654015___2002", { mode: "WEBDAV", hidden: true, files: { "app.ts": "export const a = 2;\n" } });
  const flagged = targetFor(recordingPrompt(), { classid: "654015", seqnum: "2002" });
  const viaFlag = await pullDraft(flagged, { enableGit: true });
  assert.strictEqual(viaFlag.switchedToGit, true);
});

// ── push ──────────────────────────────────────────────────────────────

test("push commits the working tree as the author and pushes the draft branch", async () => {
  const target = targetFor(recordingPrompt());
  await pullDraft(target);
  put(target, "main.ts", "export const v = 'pushed';\n");
  put(target, "lib/util.ts", "export const u = 1;\n");
  const outcome = await pushDraft(target, PUSH);
  assert.strictEqual(remoteFile("main.ts"), "export const v = 'pushed';");
  assert.strictEqual(remoteFile("lib/util.ts"), "export const u = 1;");
  assert.strictEqual(remoteLog()[0], "Ada Tester|Edit from the CLI");
  assert.strictEqual(outcome.commitSha, stub.git(bare(), "rev-parse", "draft"));
  assert.deepStrictEqual([outcome.switchedToGit, outcome.keptPlatformOnly, outcome.publish], [false, [], undefined]);
});

test("a second push with nothing new commits nothing and reports the head already on the platform", async () => {
  const target = targetFor(recordingPrompt());
  await pullDraft(target);
  put(target, "a.ts", "export {};\n");
  const first = await pushDraft(target, PUSH);
  const before = remoteLog().length;
  const second = await pushDraft(target, PUSH);
  assert.strictEqual(second.commitSha, first.commitSha);
  assert.strictEqual(remoteLog().length, before);
});

test("a snapshot push publishes and reads back that master is at the published sha", async () => {
  const target = targetFor(recordingPrompt());
  await pullDraft(target);
  put(target, "main.ts", "export const v = 'live';\n");
  const outcome = await pushDraft(target, { ...PUSH, snapshot: true });
  const master = stub.git(bare(), "rev-parse", "master");
  assert.deepStrictEqual(outcome.publish, {
    publishedSha: master,
    error: null,
    liveVerified: true,
    liveMismatches: [],
  });
  assert.strictEqual(outcome.publish.publishedSha, outcome.commitSha);
  assert.strictEqual(remoteFile("main.ts", REPO, "master"), "export const v = 'live';");
});

test("a refused publish comes back as publish.error: the draft stays pushed", async () => {
  stub.addRepo("654015___3001");
  stub.repos.get("654015___3001").refusePublish = "no entrypoint";
  const target = targetFor(recordingPrompt(), { classid: "654015", seqnum: "3001" });
  await pullDraft(target);
  put(target, "main.ts", "export const v = 'x';\n");
  const outcome = await pushDraft(target, { ...PUSH, snapshot: true });
  assert.strictEqual(outcome.publish.publishedSha, null);
  assert.ok(outcome.publish.error && outcome.publish.error.length > 0);
  assert.strictEqual(outcome.commitSha, stub.git(bare("654015___3001"), "rev-parse", "draft"));
});

test("platform edit since the last sync: --yes declines before anything is pushed, naming the files, safe option first", async () => {
  stub.addRepo("654015___4001");
  const script = { classid: "654015", seqnum: "4001" };
  const prompt = recordingPrompt(firstOption);
  const target = targetFor(prompt, script);
  await pullDraft(target);
  await platformEdit({ "main.ts": "export const v = 'theirs';\n" }, "654015___4001");
  const before = stub.git(bare("654015___4001"), "rev-parse", "draft");
  put(target, "main.ts", "export const v = 'mine';\n");
  await rejects(pushDraft(target, PUSH), (e) =>
    assert.ok(
      e instanceof Err.OverwriteDeclinedError &&
        e.message.includes("before pushing anything") &&
        !/answer|--yes|flag/i.test(e.message) &&
        JSON.stringify(e.paths) === JSON.stringify(["main.ts"]),
      String(e && e.message)
    )
  );
  assert.strictEqual(prompt.calls.length, 1);
  assertSafeFirst(prompt.calls[0], "Cancel", "Overwrite all");
  assert.strictEqual(stub.git(bare("654015___4001"), "rev-parse", "draft"), before, "nothing was pushed");
});

test("an explicit Overwrite all pushes a merge commit: the platform's history is kept, its file replaced", async () => {
  stub.addRepo("654015___4002");
  const script = { classid: "654015", seqnum: "4002" };
  const target = targetFor(recordingPrompt(pick("Overwrite all")), script);
  await pullDraft(target);
  await platformEdit({ "main.ts": "export const v = 'theirs';\n" }, "654015___4002", "Their edit");
  put(target, "main.ts", "export const v = 'mine';\n");
  await pushDraft(target, PUSH);
  assert.strictEqual(remoteFile("main.ts", "654015___4002"), "export const v = 'mine';");
  const log = remoteLog("654015___4002");
  assert.ok(log.includes("Grace Other|Their edit"), "their commit is still in the history");
  assert.strictEqual(stub.git(bare("654015___4002"), "rev-list", "--parents", "-n", "1", "draft").split(" ").length, 3);
});

test("paths the caller confirmed up front are not asked about", async () => {
  stub.addRepo("654015___4003");
  const prompt = recordingPrompt(firstOption);
  const target = targetFor(prompt, { classid: "654015", seqnum: "4003" });
  await pullDraft(target);
  await platformEdit({ "main.ts": "export const v = 'theirs';\n" }, "654015___4003");
  put(target, "main.ts", "export const v = 'mine';\n");
  await pushDraft(target, { ...PUSH, preConfirmed: ["./main.ts"] });
  assert.deepStrictEqual(prompt.calls, []);
  assert.strictEqual(remoteFile("main.ts", "654015___4003"), "export const v = 'mine';");
});

test("a platform file added since the last sync that has no local copy: --yes keeps it (and reports it); Yes drops it", async () => {
  for (const [id, answer, expectKept] of [
    ["4004", firstOption, true],
    ["4005", pick("Yes"), false],
  ]) {
    const name = `654015___${id}`;
    stub.addRepo(name);
    const prompt = recordingPrompt(answer);
    const target = targetFor(prompt, { classid: "654015", seqnum: id });
    await pullDraft(target);
    await platformEdit({ "added.ts": "export const added = 1;\n" }, name);
    put(target, "mine.ts", "export const mine = 1;\n");
    const outcome = await pushDraft(target, PUSH);
    assertSafeFirst(prompt.calls[0], "No", "Yes");
    if (expectKept) {
      assert.deepStrictEqual(outcome.keptPlatformOnly, ["added.ts"]);
      assert.strictEqual(remoteFile("added.ts", name), "export const added = 1;");
      assert.ok(prompt.warnings.some((w) => w.includes("added.ts")));
    } else {
      assert.deepStrictEqual(outcome.keptPlatformOnly, []);
      assert.throws(() => remoteFile("added.ts", name));
    }
    assert.strictEqual(remoteFile("mine.ts", name), "export const mine = 1;");
  }
});

test("a prompt that throws (no answer at all) keeps the platform-only file", async () => {
  stub.addRepo("654015___4006");
  const prompt = recordingPrompt();
  const target = targetFor(prompt, { classid: "654015", seqnum: "4006" });
  await pullDraft(target);
  await platformEdit({ "added.ts": "export const added = 1;\n" }, "654015___4006");
  put(target, "mine.ts", "x\n");
  prompt.confirm = async () => {
    throw new Error("end of input");
  };
  const outcome = await pushDraft(target, PUSH);
  assert.deepStrictEqual(outcome.keptPlatformOnly, ["added.ts"]);
});

test("a local deletion of a tracked file the platform did not touch is pushed as a deletion, with no prompt", async () => {
  stub.addRepo("654015___4007", { files: { "main.ts": "a\n", "old.ts": "b\n" } });
  const prompt = recordingPrompt();
  const target = targetFor(prompt, { classid: "654015", seqnum: "4007" });
  await pullDraft(target);
  fs.rmSync(path.join(target.draftPath, "old.ts"));
  await pushDraft(target, PUSH);
  assert.deepStrictEqual(prompt.calls, []);
  assert.throws(() => remoteFile("old.ts", "654015___4007"));
});

// ── scripts still on WebDAV, and folders from before git ──────────────

test("a folder from before git (files, no repository) is bound to the repo by a push; the switch is reported", async () => {
  stub.addRepo("654015___5001", { mode: "WEBDAV", files: { "main.ts": "export const v = 1;\n" } });
  const prompt = recordingPrompt();
  const target = targetFor(prompt, { classid: "654015", seqnum: "5001" });
  put(target, "main.ts", "export const v = 'edited before git';\n");
  put(target, "extra.ts", "export {};\n");
  // The pre-git sync recorded what main.ts held when it was last pulled: the platform still holds it.
  const lastSynced = async (rel) => (rel === "main.ts" ? sha512("export const v = 1;\n") : null);
  const outcome = await pushDraft(target, { ...PUSH, lastSynced });
  assert.strictEqual(outcome.switchedToGit, true);
  assert.strictEqual(stub.state.enableCalls >= 1, true);
  assert.deepStrictEqual(prompt.calls, [], "a local edit over an unchanged platform file asks nothing");
  assert.ok(fs.existsSync(path.join(target.draftPath, ".git")));
  assert.strictEqual(remoteFile("main.ts", "654015___5001"), "export const v = 'edited before git';");
  assert.strictEqual(remoteFile("extra.ts", "654015___5001"), "export {};");
});

test("a pre-git folder whose file the platform changed since the last sync asks before overwriting it", async () => {
  stub.addRepo("654015___5002", { files: { "main.ts": "platform now\n" } });
  const prompt = recordingPrompt(firstOption);
  const target = targetFor(prompt, { classid: "654015", seqnum: "5002" });
  put(target, "main.ts", "export const v = 'mine';\n");
  const lastSynced = async () => sha512("what it was when pulled\n");
  await rejects(pushDraft(target, { ...PUSH, lastSynced }), (e) => assert.ok(e instanceof Err.OverwriteDeclinedError));
  assertSafeFirst(prompt.calls[0], "Cancel", "Overwrite all");
});

test("pulling a pre-git folder binds it: its unedited files take the platform copy, its edited ones are kept", async () => {
  stub.addRepo("654015___5003", {
    files: { "same.ts": "same\n", "stale.ts": "platform\n", "edited.ts": "platform\n" },
  });
  const target = targetFor(recordingPrompt(), { classid: "654015", seqnum: "5003" });
  put(target, "same.ts", "same\n");
  put(target, "stale.ts", "old platform copy\n");
  put(target, "edited.ts", "my edit\n");
  const lastSynced = async (rel) =>
    rel === "stale.ts" ? sha512("old platform copy\n") : rel === "edited.ts" ? sha512("platform base\n") : null;
  const outcome = await pullDraft(target, { lastSynced });
  assert.deepStrictEqual(outcome.keptLocalPaths, [path.join(target.draftPath, "edited.ts")]);
  assert.strictEqual(read(target, "stale.ts"), "platform\n");
  assert.strictEqual(read(target, "edited.ts"), "my edit\n");
  assert.ok(fs.existsSync(path.join(target.draftPath, ".git")));
});

test("a deploy (adoptUnbound: false) pushes the folder's files to the target through a scratch clone and leaves the folder unbound", async () => {
  stub.addRepo("654015___6001", { files: { "main.ts": "old target\n", "gone.ts": "x\n" } });
  const prompt = recordingPrompt(pick("Overwrite all"));
  const target = targetFor(prompt, { classid: "654015", seqnum: "6001" });
  put(target, "main.ts", "export const v = 'deployed';\n");
  put(target, ".gitignore", "ignored.txt\n");
  put(target, "ignored.txt", "never\n");
  const outcome = await pushDraft(target, { ...PUSH, adoptUnbound: false });
  assert.strictEqual(remoteFile("main.ts", "654015___6001"), "export const v = 'deployed';");
  assert.strictEqual(remoteFile(".gitignore", "654015___6001"), "ignored.txt");
  assert.throws(() => remoteFile("ignored.txt", "654015___6001"));
  assert.ok(!fs.existsSync(path.join(target.draftPath, ".git")), "the source folder was not bound to the target");
  assert.ok(outcome.commitSha);
  // gone.ts is on the platform only: the prompt answered Overwrite all to the first question; the delete question
  // got the same (not Yes), so it is kept.
  assert.deepStrictEqual(outcome.keptPlatformOnly, ["gone.ts"]);
});

// ── author ────────────────────────────────────────────────────────────

test("the author is the explicit one, then git config, then the environment, else a clear error", async () => {
  const reader = (values) => async (_dir, key) => values[key];
  const config = { "user.name": "Config Name", "user.email": "config@example.test" };
  const env = { GIT_AUTHOR_NAME: "Env Name", GIT_AUTHOR_EMAIL: "env@example.test" };
  const explicit = { name: "Explicit", email: "explicit@example.test" };
  assert.deepStrictEqual(
    await resolveGitIdentity({ explicit, dir: tmp, env, readGitConfig: reader(config) }),
    explicit
  );
  assert.deepStrictEqual(await resolveGitIdentity({ dir: tmp, env, readGitConfig: reader(config) }), {
    name: "Config Name",
    email: "config@example.test",
  });
  assert.deepStrictEqual(
    await resolveGitIdentity({ dir: tmp, env, readGitConfig: reader({ "user.name": "Only Name" }) }),
    {
      name: "Env Name",
      email: "env@example.test",
    }
  );
  assert.deepStrictEqual(
    await resolveGitIdentity({
      dir: tmp,
      env: { GIT_COMMITTER_NAME: "Committer", GIT_COMMITTER_EMAIL: "c@example.test" },
      readGitConfig: reader({}),
    }),
    { name: "Committer", email: "c@example.test" }
  );
  await rejects(resolveGitIdentity({ dir: tmp, env: {}, readGitConfig: reader({}) }), (e) => {
    assert.ok(e instanceof bsjsGit.GitIdentityError);
    assert.ok(/No commit author found/.test(e.message));
    assert.ok(!/unknown/i.test(e.message));
  });
  await rejects(resolveGitIdentity({ explicit: { name: "x", email: " " }, dir: tmp, env }), (e) =>
    assert.ok(e instanceof bsjsGit.GitIdentityError)
  );
});

test("the default git config reader asks git itself (global config included)", async () => {
  const globalConfig = path.join(tmp, "gitconfig");
  fs.writeFileSync(globalConfig, "[user]\n\tname = Global Person\n\temail = global@example.test\n");
  const saved = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_SYSTEM };
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_SYSTEM = os.devNull;
  try {
    assert.deepStrictEqual(await resolveGitIdentity({ dir: tmp, env: {} }), {
      name: "Global Person",
      email: "global@example.test",
    });
  } finally {
    for (const [key, value] of [
      ["GIT_CONFIG_GLOBAL", saved.global],
      ["GIT_CONFIG_SYSTEM", saved.system],
    ]) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

// ── executePush: the result b6p-cli consumes ──────────────────────────

/** A ScriptContext fake enough for a plain (non-snapshot) executePush over a real draft folder. */
function pushContext(prompt, scriptId) {
  const [classid, seqnum] = scriptId.split("___");
  const parents = (id) =>
    id.startsWith("530001___")
      ? [{ id: "media-library" }]
      : [{ id: `${classid}___${seqnum}`, displayName: "MyScript" }];
  const csrfFetch = async (_url, init) => {
    const id = /"id":"([^"]+)"/.exec(init.body)[1];
    return new Response(JSON.stringify({ data: { parents: parents(id) } }), { status: 200 });
  };
  const rawFs = {
    exists: async (uri) => fs.existsSync(uri.fsPath),
    readDirectory: async (uri) =>
      fs.readdirSync(uri.fsPath, { withFileTypes: true }).map((e) => [e.name, e.isDirectory() ? "directory" : "file"]),
    findFiles: async () => [],
    stat: async (uri) => {
      const s = fs.statSync(uri.fsPath);
      return { type: s.isDirectory() ? "directory" : "file", mtime: s.mtimeMs, ctime: s.ctimeMs, size: s.size };
    },
  };
  const metadata = { pushPullRecords: [] };
  return {
    ...fakeCtx(prompt),
    fs: rawFs,
    sessionManager: { csrfFetch },
    scriptMetadataStore: {
      whenReady: async () => {},
      findByScriptName: () => metadata,
      upsert: async () => {},
    },
    isDebugMode: () => false,
  };
}

test("executePush (plain): the result carries commitSha, no publishedSha, and no historyRecorded", async () => {
  const prompt = recordingPrompt();
  const rootPath = path.join(tmp, `ws${++n}`, "U100001", "MyScript");
  const draftPath = path.join(rootPath, "draft");
  const ctx = pushContext(prompt, REPO);
  const target = { ctx, script: SCRIPT, baseUrl, draftPath };
  await pullDraft(target);
  fs.writeFileSync(path.join(draftPath, "main.ts"), "export const v = 'via executePush';\n");
  const result = await executePush({
    ctx,
    targetUrl: `${baseUrl}files/100001/`,
    rootPath,
    snapshot: false,
    message: "Via executePush",
    author: AUTHOR,
  });
  assert.deepStrictEqual(Object.keys(result).sort(), [
    "commitSha",
    "keptPlatformOnly",
    "liveMismatches",
    "liveVerified",
    "publishError",
    "publishedSha",
    "pushed",
    "switchedToGit",
    "typeCheckDiagnostics",
  ]);
  assert.strictEqual(result.pushed, true);
  assert.strictEqual(result.commitSha, stub.git(bare(), "rev-parse", "draft"));
  assert.strictEqual(result.publishedSha, null);
  assert.strictEqual(result.liveVerified, null);
  assert.strictEqual(remoteLog()[0], "Ada Tester|Via executePush");
});

test("executePush without any author fails before touching the platform or the folder", async () => {
  const prompt = recordingPrompt();
  const rootPath = path.join(tmp, `ws${++n}`, "U100001", "MyScript");
  fs.mkdirSync(path.join(rootPath, "draft"), { recursive: true });
  fs.writeFileSync(path.join(rootPath, "draft", "a.ts"), "x\n");
  const ctx = { ...pushContext(prompt, REPO), gitEnv: {} };
  const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = os.devNull;
  const savedSystem = process.env.GIT_CONFIG_SYSTEM;
  process.env.GIT_CONFIG_SYSTEM = os.devNull;
  const gqlBefore = stub.state.gqlRequests;
  try {
    await rejects(executePush({ ctx, targetUrl: `${baseUrl}files/100001/`, rootPath, snapshot: false }), (e) =>
      assert.ok(e instanceof bsjsGit.GitIdentityError, String(e && e.message))
    );
  } finally {
    for (const [key, value] of [
      ["GIT_CONFIG_GLOBAL", savedGlobal],
      ["GIT_CONFIG_SYSTEM", savedSystem],
    ]) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
  assert.strictEqual(stub.state.gqlRequests, gqlBefore);
  assert.ok(!fs.existsSync(path.join(rootPath, "draft", ".git")));
});

test("executePush on an empty draft folder pushes nothing and says so in the result", async () => {
  const prompt = recordingPrompt();
  const rootPath = path.join(tmp, `ws${++n}`, "U100001", "MyScript");
  fs.mkdirSync(path.join(rootPath, "draft"), { recursive: true });
  const result = await executePush({
    ctx: pushContext(prompt, REPO),
    targetUrl: `${baseUrl}files/100001/`,
    rootPath,
    snapshot: false,
    author: AUTHOR,
  });
  assert.deepStrictEqual([result.pushed, result.commitSha, result.publishedSha], [false, null, null]);
});

(async () => {
  baseUrl = await stub.listen();
  stub.addRepo(REPO);
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log("ok   -", name);
    } catch (e) {
      failures++;
      console.error("FAIL -", name, "\n     ", e && e.stack ? e.stack.split("\n").slice(0, 6).join("\n      ") : e);
    }
  }
  await stub.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll GitDraftSync tests passed.");
})();
