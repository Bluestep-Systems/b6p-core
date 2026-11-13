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
  const outcome = await pushDraft(target, { ...PUSH, lastSynced, enableGit: true });
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

// ── review follow-ups ─────────────────────────────────────────────────

const { legacyIgnoreRulesForDraft, GitWrongBranchError, GitStagedChangesError } = require("../dist/script/GitSync.js");
const { ScriptService } = require("../dist/script/ScriptService.js");

function trySymlink(target, link) {
  try {
    fs.symlinkSync(target, link);
    return true;
  } catch {
    return false; // no permission to create links here (some Windows set-ups): nothing to test
  }
}

test("1. consents come before anything is installed: a cancelled overwrite leaves the folder without a .git, and the retry asks again", async () => {
  stub.addRepo("654015___9001", { mode: "WEBDAV", files: { "main.ts": "platform copy\n" } });
  const asked = [];
  const prompt = recordingPrompt((options) => {
    asked.push(options[0]);
    return options[0] === "Cancel" && options.includes("Switch to git") ? "Switch to git" : options[0];
  });
  const target = targetFor(prompt, { classid: "654015", seqnum: "9001" });
  put(target, "main.ts", "export const v = 'mine';\n");
  const declined = recordingPrompt(firstOption);
  const first = { ...target, ctx: { ...target.ctx, prompt: declined } };
  await rejects(pushDraft(first, PUSH), (e) => assert.ok(e instanceof GitSwitchDeclinedError));
  assert.strictEqual(stub.repos.get("654015___9001").mode, "WEBDAV", "a declined switch switches nothing");
  assert.ok(!fs.existsSync(path.join(target.draftPath, ".git")));

  await rejects(pushDraft(target, PUSH), (e) => assert.ok(e instanceof Err.OverwriteDeclinedError));
  assert.ok(!fs.existsSync(path.join(target.draftPath, ".git")), "no .git was installed by a cancelled push");
  assert.ok(!fs.existsSync(path.join(path.dirname(target.draftPath), ".b6p-adopt")), "the scratch clone is gone");
  assert.strictEqual(read(target, "main.ts"), "export const v = 'mine';\n");
  const askedOverwrite = prompt.calls.filter((c) => c.options.includes("Overwrite all")).length;
  await rejects(pushDraft(target, PUSH), (e) => assert.ok(e instanceof Err.OverwriteDeclinedError));
  assert.strictEqual(
    prompt.calls.filter((c) => c.options.includes("Overwrite all")).length,
    askedOverwrite + 1,
    "the retry asks again"
  );
});

test("2. a draft folder with another branch checked out is refused: nothing is committed, no commitSha is reported", async () => {
  stub.addRepo("654015___9002");
  const target = targetFor(recordingPrompt(), { classid: "654015", seqnum: "9002" });
  await pullDraft(target);
  stub.git(target.draftPath, "checkout", "-q", "-b", "feature");
  put(target, "new.ts", "x\n");
  const before = stub.git(bare("654015___9002"), "rev-parse", "draft");
  await rejects(pushDraft(target, PUSH), (e) => assert.ok(e instanceof GitWrongBranchError, String(e && e.message)));
  assert.strictEqual(
    stub.git(target.draftPath, "rev-list", "--count", "feature"),
    stub.git(target.draftPath, "rev-list", "--count", "draft"),
    "feature was not advanced"
  );
  assert.strictEqual(stub.git(bare("654015___9002"), "rev-parse", "draft"), before);
});

test("3. the old script-root .gitignore rules carry over: an ignored secret is never committed (push and deploy)", async () => {
  assert.deepStrictEqual(
    legacyIgnoreRulesForDraft("# c\ndraft/secret.txt\n**/*.key\n!draft/keep.key\n/declarations/x\n*.log\n.DS_Store\n"),
    ["/secret.txt", "**/*.key", "!/keep.key"]
  );
  for (const [id, adopt] of [
    ["9003", true],
    ["9004", false],
  ]) {
    stub.addRepo(`654015___${id}`);
    const target = targetFor(recordingPrompt(pick("Overwrite all")), { classid: "654015", seqnum: id });
    fs.mkdirSync(path.dirname(target.draftPath), { recursive: true });
    fs.writeFileSync(
      path.join(path.dirname(target.draftPath), ".gitignore"),
      "**/.DS_Store\ndraft/secret.txt\n**/*.key\n"
    );
    if (adopt) {
      await pullDraft(target);
    }
    put(target, "secret.txt", "api-key\n");
    put(target, "deep/server.key", "private\n");
    put(target, "ok.ts", "export {};\n");
    await pushDraft(target, { ...PUSH, adoptUnbound: adopt });
    assert.strictEqual(remoteFile("ok.ts", `654015___${id}`), "export {};");
    assert.throws(() => remoteFile("secret.txt", `654015___${id}`), `${id}: secret.txt must not be committed`);
    assert.throws(() => remoteFile("deep/server.key", `654015___${id}`), `${id}: *.key must not be committed`);
  }
});

test("4. symlinks are never followed out of the draft folder (deploy reads, pull writes)", async () => {
  stub.addRepo("654015___9005");
  const target = targetFor(recordingPrompt(pick("Overwrite all")), { classid: "654015", seqnum: "9005" });
  const outside = path.join(tmp, `outside${++n}`);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside\n");
  put(target, "main.ts", "export {};\n");
  if (
    !trySymlink(outside, path.join(target.draftPath, "linkdir")) ||
    !trySymlink(path.join(outside, "secret.txt"), path.join(target.draftPath, "linkfile"))
  ) {
    return;
  }
  const warnings = target.ctx.prompt.warnings;
  await pushDraft(target, { ...PUSH, adoptUnbound: false });
  assert.throws(() => remoteFile("linkfile", "654015___9005"));
  assert.throws(() => remoteFile("linkdir/secret.txt", "654015___9005"));
  assert.ok(warnings.some((w) => /symbolic link/.test(w) && w.includes("linkfile")));

  // A pull whose incoming file would be written through a link is refused, and nothing lands outside.
  stub.addRepo("654015___9006");
  const pulled = targetFor(recordingPrompt(), { classid: "654015", seqnum: "9006" });
  await pullDraft(pulled);
  await platformEdit({ "evil/x.txt": "pwned\n" }, "654015___9006");
  if (!trySymlink(outside, path.join(pulled.draftPath, "evil"))) {
    return;
  }
  await rejects(pullDraft(pulled), (e) => assert.ok(e instanceof core.GitSymlinkError));
  assert.ok(!fs.existsSync(path.join(outside, "x.txt")));
});

test("5. a pull refuses to discard index-only changes, and keeps an ignored local file the platform started tracking", async () => {
  stub.addRepo("654015___9007");
  const target = targetFor(recordingPrompt(), { classid: "654015", seqnum: "9007" });
  await pullDraft(target);
  put(target, "main.ts", "export const staged = 1;\n");
  stub.git(target.draftPath, "add", "main.ts");
  put(target, "main.ts", "export const edited = 2;\n");
  await platformEdit({ "other.ts": "o\n" }, "654015___9007");
  await rejects(pullDraft(target), (e) => assert.ok(e instanceof GitStagedChangesError && e.paths.includes("main.ts")));
  assert.strictEqual(read(target, "main.ts"), "export const edited = 2;\n", "nothing was changed");
  assert.ok(!fs.existsSync(path.join(target.draftPath, "other.ts")));
  stub.git(target.draftPath, "reset", "-q");

  fs.appendFileSync(path.join(target.draftPath, ".git", "info", "exclude"), "local.txt\n");
  put(target, "local.txt", "mine\n");
  await platformEdit({ "local.txt": "theirs\n" }, "654015___9007");
  const outcome = await pullDraft(target);
  assert.ok(outcome.keptLocalPaths.includes(path.join(target.draftPath, "local.txt")));
  assert.strictEqual(read(target, "local.txt"), "mine\n");
  assert.strictEqual(read(target, "other.ts"), "o\n", "the rest of the platform's changes still arrived");
});

test("6. a file the platform deleted is not resurrected by a push without the confirmation", async () => {
  stub.addRepo("654015___9008", { files: { "main.ts": "a\n", "old.ts": "b\n" } });
  const prompt = recordingPrompt(firstOption);
  const target = targetFor(prompt, { classid: "654015", seqnum: "9008" });
  await pullDraft(target);
  await platformEdit({ "old.ts": null }, "654015___9008", "Delete old");
  put(target, "main.ts", "export const v = 'mine';\n");
  await rejects(pushDraft(target, PUSH), (e) => {
    assert.ok(e instanceof Err.OverwriteDeclinedError);
    assert.deepStrictEqual(e.paths, ["old.ts"]);
    assert.ok(/deleted on the platform/.test(e.message));
  });
  assertSafeFirst(prompt.calls[0], "Cancel", "Overwrite all");
  assert.throws(() => remoteFile("old.ts", "654015___9008"), "still deleted on the platform");
  const yes = targetFor(recordingPrompt(pick("Overwrite all")), { classid: "654015", seqnum: "9008" });
  await pullDraft(yes);
  assert.ok(!fs.existsSync(path.join(yes.draftPath, "old.ts")), "a pull deletes it");
});

test("7. a read-only mirror bound to a WEBDAV script: the push asks for the switch (decline changes nothing), then pushes", async () => {
  stub.addRepo("654015___9009", { mode: "WEBDAV", files: { "main.ts": "a\n" } });
  const target = targetFor(recordingPrompt(firstOption), { classid: "654015", seqnum: "9009" });
  fs.mkdirSync(target.draftPath, { recursive: true });
  const mirror = new bsjsGit.ScriptRepo({
    fs,
    dir: target.draftPath,
    script: target.script,
    baseUrl,
    auth: { kind: "token", token: stub.TOKEN },
  });
  await mirror.clone();
  put(target, "main.ts", "export const v = 'edited the mirror';\n");
  const before = stub.state.enableCalls;
  await rejects(pushDraft(target, PUSH), (e) => assert.ok(e instanceof GitSwitchDeclinedError));
  assert.strictEqual(stub.state.enableCalls, before);
  const outcome = await pushDraft(target, { ...PUSH, enableGit: true });
  assert.strictEqual(outcome.switchedToGit, true);
  assert.strictEqual(remoteFile("main.ts", "654015___9009"), "export const v = 'edited the mirror';");
});

test("8. deploy uses real git ignore semantics: a negated pattern keeps its file", async () => {
  stub.addRepo("654015___9010");
  const target = targetFor(recordingPrompt(pick("Overwrite all")), { classid: "654015", seqnum: "9010" });
  put(target, ".gitignore", "*.txt\n!keep.txt\n");
  put(target, "a.txt", "drop\n");
  put(target, "keep.txt", "keep\n");
  put(target, "main.ts", "export {};\n");
  await pushDraft(target, { ...PUSH, adoptUnbound: false });
  assert.strictEqual(remoteFile("keep.txt", "654015___9010"), "keep");
  assert.throws(() => remoteFile("a.txt", "654015___9010"));
});

test("9. a confirmed audit-pull overwrite takes the fetched platform copy, not the local branch's", async () => {
  stub.addRepo("654015___9011", { files: { "main.ts": "platform\n" } });
  const target = targetFor(recordingPrompt(), { classid: "654015", seqnum: "9011" });
  await pullDraft(target);
  const local = await openRepoFor(target);
  put(target, "main.ts", "local commit\n");
  await local.commit("local only", AUTHOR);
  const outcome = await pullDraft(target, { overwrite: ["main.ts"] });
  assert.deepStrictEqual(outcome.keptLocalPaths, []);
  assert.strictEqual(read(target, "main.ts"), "platform\n");
});

async function openRepoFor(target) {
  return new bsjsGit.ScriptRepo({
    fs,
    dir: target.draftPath,
    script: target.script,
    baseUrl,
    auth: { kind: "token", token: stub.TOKEN },
    author: AUTHOR,
  });
}

test("10. a garbled publish answer after a successful push keeps the partial result: commitSha and publish.error", async () => {
  stub.addRepo("654015___9012");
  stub.repos.get("654015___9012").garblePublish = true;
  const target = targetFor(recordingPrompt(), { classid: "654015", seqnum: "9012" });
  await pullDraft(target);
  put(target, "main.ts", "export const v = 'x';\n");
  const outcome = await pushDraft(target, { ...PUSH, snapshot: true });
  assert.strictEqual(outcome.commitSha, stub.git(bare("654015___9012"), "rev-parse", "draft"));
  assert.strictEqual(outcome.publish.publishedSha, null);
  assert.ok(outcome.publish.error);
});

test("11. pullCurrent passes enableGit through to pull", async () => {
  const service = new ScriptService({ logger, prompt: recordingPrompt() });
  const pulls = [];
  service.deriveBaseUrl = async () => "https://org.bluestep.net/files/1/";
  service.pull = async (opts) => {
    pulls.push(opts);
    return null;
  };
  await service.pullCurrent({ filePath: path.join(tmp, "f"), workspacePath: tmp, enableGit: true });
  assert.strictEqual(pulls[0].enableGit, true);
});

test("12. a snapshot push publishes the draft commit it pushed (the publish names it: expectedDraftSha)", async () => {
  stub.addRepo("654015___9013");
  const target = targetFor(recordingPrompt(), { classid: "654015", seqnum: "9013" });
  await pullDraft(target);
  put(target, "main.ts", "export const v = 'named';\n");
  const outcome = await pushDraft(target, { ...PUSH, snapshot: true });
  assert.strictEqual(stub.state.publishInputs.at(-1).expectedDraftSha, outcome.commitSha);
  assert.strictEqual(outcome.publish.publishedSha, outcome.commitSha);
});

test("deploy returns a result per target: a target failing on identity does not hide the one that succeeded, and no success is printed", async () => {
  const prompt = recordingPrompt();
  const errors = [];
  prompt.error = (m) => errors.push(m);
  const infos = [];
  prompt.info = (m) => infos.push(m);
  const config = JSON.stringify({
    sourceRootPath: tmp,
    targets: [{ url: "https://a.example.test/files/1/", snapshot: true }, { url: "https://b.example.test/files/2/" }],
  });
  const ctx = {
    ...fakeCtx(prompt),
    fs: { exists: async () => true, readFile: async () => Buffer.from(config) },
  };
  const service = new ScriptService(ctx);
  service.push = async (opts) => {
    if (opts.targetUrl.includes("//b.")) {
      throw new bsjsGit.GitIdentityError("No commit author found");
    }
    return {
      pushed: true,
      commitSha: "a".repeat(40),
      publishedSha: "a".repeat(40),
      publishError: null,
      switchedToGit: false,
    };
  };
  const results = await service.deploy({ configPath: path.join(tmp, "deploy.json") });
  assert.strictEqual(results.length, 2);
  assert.deepStrictEqual(results[0], {
    target: "https://a.example.test/files/1/",
    pushed: true,
    commitSha: "a".repeat(40),
    publishedSha: "a".repeat(40),
    publishError: null,
    switchedToGit: false,
  });
  assert.strictEqual(results[1].pushed, false);
  assert.ok(results[1].error instanceof bsjsGit.GitIdentityError);
  assert.ok(!infos.some((m) => /Deploy complete/.test(m)), "no success while a target failed");
  assert.ok(errors.some((m) => m.includes("1 of 2") && m.includes("https://b.example.test/files/2/")));
});

test("a declined overwrite after the switch says the switch stands (OverwriteDeclinedError.switchedToGit), and so does a deploy target result", async () => {
  stub.addRepo("654015___9101", { mode: "WEBDAV", files: { "main.ts": "platform copy\n" } });
  const target = targetFor(recordingPrompt(firstOption), { classid: "654015", seqnum: "9101" });
  put(target, "main.ts", "export const v = 'mine';\n");
  await rejects(pushDraft(target, { ...PUSH, enableGit: true }), (e) => {
    assert.ok(e instanceof Err.OverwriteDeclinedError);
    assert.strictEqual(e.switchedToGit, true);
  });
  assert.strictEqual(stub.repos.get("654015___9101").mode, "GIT", "the switch is permanent");

  // Already git: declined, and nothing was switched by this push.
  stub.addRepo("654015___9102", { files: { "main.ts": "platform copy\n" } });
  const gitTarget = targetFor(recordingPrompt(firstOption), { classid: "654015", seqnum: "9102" });
  put(gitTarget, "main.ts", "mine\n");
  await rejects(pushDraft(gitTarget, { ...PUSH, adoptUnbound: false, lastSynced: async () => null }), (e) => {
    assert.ok(e instanceof Err.OverwriteDeclinedError);
    assert.strictEqual(e.switchedToGit, false);
  });

  const config = JSON.stringify({ sourceRootPath: tmp, targets: [{ url: "https://a.example.test/files/1/" }] });
  const service = new ScriptService({
    ...fakeCtx(recordingPrompt()),
    fs: { exists: async () => true, readFile: async () => Buffer.from(config) },
  });
  service.push = async () => {
    const error = new Err.OverwriteDeclinedError("declined", ["main.ts"]);
    error.switchedToGit = true;
    throw error;
  };
  const results = await service.deploy({ configPath: path.join(tmp, "deploy.json") });
  assert.strictEqual(results[0].switchedToGit, true);
  assert.ok(results[0].error instanceof Err.OverwriteDeclinedError);
});

test("a snapshot push writes the build manifest in the same commit as the output; without it the publish is refused (stale/missing), and deploy carries it too", async () => {
  for (const [id, adopt] of [
    ["9201", true],
    ["9202", false],
  ]) {
    const name = `654015___${id}`;
    stub.addRepo(name, { files: { "tsconfig.json": "{}\n", "scripts/app.ts": "export const v = 1;\n" } });
    const target = targetFor(recordingPrompt(pick("Overwrite all")), { classid: "654015", seqnum: id });
    if (adopt) {
      await pullDraft(target);
    } else {
      put(target, "tsconfig.json", "{}\n");
    }
    put(target, "scripts/app.ts", "export const v = 2;\n");
    put(target, ".build/scripts/app.js", "exports.v = 2;\n");
    const refused = await pushDraft(target, { ...PUSH, snapshot: true, adoptUnbound: adopt });
    assert.ok(/BUILD_/.test(refused.publish.error) || /build/i.test(refused.publish.error), "no manifest: refused");
    assert.strictEqual(refused.publish.publishedSha, null);

    const built = await pushDraft(target, {
      ...PUSH,
      snapshot: true,
      adoptUnbound: adopt,
      buildManifest: {},
      message: "Build",
    });
    assert.strictEqual(built.publish.error, null, String(built.publish.error));
    const manifest = JSON.parse(remoteFile(".build/.b6p-build.json", name, "master"));
    assert.deepStrictEqual(Object.keys(manifest.sources), ["scripts/app.ts", "tsconfig.json"]);
    assert.strictEqual(
      remoteFile(".build/scripts/app.js", name, "master"),
      "exports.v = 2;",
      "the output is in the same commit"
    );
  }
  for (const name of [
    "PublishBuildStaleError",
    "PublishBuildManifestMissingError",
    "PublishBuildManifestInvalidError",
  ]) {
    assert.strictEqual(typeof bsjsGit[name], "function", name);
  }
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
