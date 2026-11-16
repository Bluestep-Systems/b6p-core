// Behavioral spec for ScriptRepo.compileDraft: the platform builds the pushed draft (GraphQL compileDraft pinned with
// expectedDraftSha), commits the output (and the manifest when it vouches) as one build commit, and the client
// fast-forwards to it. Nothing compiles on the client. Runs against the platform stand-in (support/GitProxyStub.js),
// whose build writes stand-in output. Dependency-free node script over the COMPILED dist/ (run via `npm test`).

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStub } = require("./support/GitProxyStub");
const lib = require("../dist/index.js");

const AUTHOR = { name: "Ada Tester", email: "ada@example.test" };
let failures = 0;
const pending = [];
function test(name, fn) {
  pending.push([name, fn]);
}

const stub = createStub();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cd-work-"));
let baseUrl;
let n = 0;
let seq = 8000;
const SEED = { "tsconfig.json": "{}", "scripts/app.ts": "export const v = 1;\n" };

function repoFor(id) {
  const dir = path.join(tmp, `wt${++n}`);
  fs.mkdirSync(dir);
  const [classid, seqnum] = id.split("___");
  return new lib.ScriptRepo({
    fs,
    dir,
    script: { classid, seqnum },
    baseUrl,
    auth: { kind: "token", token: stub.TOKEN },
    author: AUTHOR,
  });
}
/** A new script on the stand-in, cloned, with one pushed edit. */
async function pushed(files = SEED, options = {}) {
  const id = `654015___${++seq}`;
  stub.addRepo(id, { files });
  Object.assign(stub.repos.get(id), options);
  const repo = repoFor(id);
  await repo.clone();
  await repo.writeFile("scripts/app.ts", "export const v = 2;\n");
  await repo.commit("edit", AUTHOR);
  await repo.push();
  return { id, repo, entry: stub.repos.get(id) };
}
async function rejects(promise, type, check) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof type, `expected ${type.name}, got ${error && error.name}: ${error && error.message}`);
    check?.(error);
    return;
  }
  assert.fail(`expected ${type.name}`);
}
const noSleep = () => {
  const waits = [];
  return { waits, sleep: async (ms) => void waits.push(ms) };
};

test("a clean build: one build commit with output and manifest, authored by the pushing user; the folder is fast-forwarded and the build publishes", async () => {
  const { id, repo, entry } = await pushed();
  const pushedSha = await repo.sha("draft");
  entry.buildAuthor = { name: "Ada Tester", email: "ada@example.test" };
  const result = await repo.compileDraft();
  assert.strictEqual(result.compile.status, "COMPILED");
  assert.strictEqual(result.vouched, true);
  assert.ok(result.buildCommitSha && result.buildCommitSha !== pushedSha);
  assert.strictEqual(result.head, result.buildCommitSha);
  assert.strictEqual(await repo.sha("draft"), result.buildCommitSha, "the local draft is at the build commit");
  assert.strictEqual(stub.git(entry.bare, "rev-parse", "draft"), result.buildCommitSha);
  assert.strictEqual(stub.git(entry.bare, "log", "-1", "--format=%an|%s", "draft"), "Ada Tester|Build draft");
  assert.ok(fs.existsSync(path.join(repo.dir, ".build", "scripts", "app.js")), "the output is in the working tree");
  assert.ok(fs.existsSync(path.join(repo.dir, ".build", ".b6p-build.json")), "so is the manifest");
  assert.deepStrictEqual(await repo.status(), [], "nothing is left uncommitted");
  const input = stub.state.buildInputs.at(-1);
  assert.deepStrictEqual([input.topId, input.compileDraft, input.expectedDraftSha], [id, true, pushedSha]);
  assert.strictEqual((await repo.publish()).publishedSha, result.buildCommitSha);
});

test("asked again at the build commit, the build changes nothing: no new commit, buildCommitSha null", async () => {
  const { repo, entry } = await pushed();
  const first = await repo.compileDraft();
  const again = await repo.compileDraft();
  assert.strictEqual(again.buildCommitSha, null);
  assert.strictEqual(again.head, first.buildCommitSha);
  assert.strictEqual(stub.git(entry.bare, "rev-parse", "draft"), first.buildCommitSha);
});

test("an unclean build commits the output without a manifest: vouched false, and the publish is refused", async () => {
  const { repo } = await pushed(SEED, {
    buildUnclean: true,
    buildDiagnostics: [
      {
        origin: "TYPESCRIPT",
        severity: "ERROR",
        code: 1005,
        file: "scripts/app.ts",
        line: 1,
        column: 9,
        message: "';' expected.",
      },
    ],
  });
  const result = await repo.compileDraft();
  assert.strictEqual(result.vouched, false);
  assert.ok(result.buildCommitSha);
  assert.strictEqual(result.compile.errors, 1);
  assert.deepStrictEqual(result.compile.diagnostics[0], {
    origin: "TYPESCRIPT",
    severity: "ERROR",
    code: 1005,
    file: "scripts/app.ts",
    line: 1,
    column: 9,
    message: "';' expected.",
  });
  assert.ok(fs.existsSync(path.join(repo.dir, ".build", "scripts", "app.js")));
  assert.ok(!fs.existsSync(path.join(repo.dir, ".build", ".b6p-build.json")));
  await rejects(repo.publish(), lib.PublishBuildManifestMissingError);
});

test("a draft that moved since the push is refused DRAFT_MOVED: nothing is built, the local draft stays", async () => {
  const { repo, entry } = await pushed();
  const before = await repo.sha("draft");
  entry.beforeBuild = () => {
    entry.beforeBuild = undefined;
    // Someone else's push lands between this client's push and its build request (synchronously, by the stub's git).
    const work = fs.mkdtempSync(path.join(tmp, "other-"));
    stub.git(tmp, "clone", "-q", "-b", "draft", entry.bare, work);
    fs.writeFileSync(path.join(work, "other.txt"), "x\n");
    stub.git(work, "add", "-A");
    stub.git(work, "-c", "user.name=O", "-c", "user.email=o@x", "commit", "-q", "-m", "other");
    stub.git(work, "push", "-q", entry.bare, "draft");
  };
  await rejects(repo.compileDraft(), lib.DraftBuildMovedError, (e) => {
    assert.ok(e instanceof lib.DraftBuildFailedError);
    assert.strictEqual(e.code, "BUILD_FAILED");
  });
  assert.strictEqual(await repo.sha("draft"), before);
});

test("BUSY and INPUT_INCOMPLETE are retried by COMPILE_RETRY, a 503 once; the last outcome wins when retries run out", async () => {
  const { repo, entry } = await pushed();
  entry.buildQueue = ["BUSY", "INPUT_INCOMPLETE", "NETWORK"];
  const { waits, sleep } = noSleep();
  const result = await repo.compileDraft({ sleep });
  assert.strictEqual(result.compile.status, "COMPILED");
  assert.deepStrictEqual(waits, [5_000, 2_000, 2_000]);

  entry.buildQueue = ["BUSY", "BUSY", "BUSY", "BUSY"];
  const busy = await repo.compileDraft(noSleep());
  assert.strictEqual(busy.compile.status, "BUSY");
  assert.strictEqual(busy.buildCommitSha, null);
  entry.buildQueue = [];
});

test("a GraphQL error is DraftBuildFailedError; two failed requests are a network failure", async () => {
  const { repo, entry } = await pushed();
  entry.buildQueue = ["GRAPHQL_ERROR"];
  await rejects(repo.compileDraft(), lib.DraftBuildFailedError, (e) => {
    assert.deepStrictEqual(e.messages, ["You may not edit this script"]);
    assert.strictEqual(e.networkFailure, false);
  });
  entry.buildQueue = ["NETWORK", "NETWORK"];
  await rejects(repo.compileDraft(noSleep()), lib.DraftBuildFailedError, (e) =>
    assert.strictEqual(e.networkFailure, true)
  );
});

test("a local draft the platform does not hold is refused before any request", async () => {
  const { repo } = await pushed();
  await repo.writeFile("scripts/app.ts", "export const v = 3;\n");
  await repo.commit("not pushed", AUTHOR);
  const before = stub.state.buildInputs.length;
  await rejects(repo.compileDraft(), lib.GitUnpushedChangesError);
  assert.strictEqual(stub.state.buildInputs.length, before);
});

test("a draft with nothing to build (no tsconfig, or no TypeScript source) makes no build commit and publishes", async () => {
  const { repo } = await pushed({ "scripts/app.ts": "export const v = 1;\n" });
  const result = await repo.compileDraft();
  assert.strictEqual(result.compile.status, "NOTHING_TO_COMPILE");
  assert.strictEqual(result.buildCommitSha, null);
  assert.strictEqual(result.vouched, true, "nothing to build needs no manifest");
  await repo.publish();
});

test("parsers: an unknown status is UNKNOWN with the raw text; a build commit that is not a sha reads as null", () => {
  const outcome = lib.parseDraftCompileOutcome({ status: "NEW_THING", errors: 2 });
  assert.deepStrictEqual([outcome.status, outcome.rawStatus, outcome.errors], ["UNKNOWN", "NEW_THING", 2]);
  assert.deepStrictEqual(lib.parseDraftBuildCommit({ commit: "abc", vouched: true }), { commit: null, vouched: true });
  assert.deepStrictEqual(lib.parseDraftBuildCommit(undefined), { commit: null, vouched: false });
  const sha256 = "a".repeat(64);
  assert.deepStrictEqual(lib.parseDraftBuildCommit({ commit: sha256, built: true, vouched: false }), {
    commit: sha256,
    vouched: false,
  });
  assert.strictEqual(lib.compileAllowsPublish("COMPILED"), true);
  assert.strictEqual(lib.compileAllowsPublish("GATE_TRIPPED"), false);
});

(async () => {
  baseUrl = await stub.listen();
  for (const [name, fn] of pending) {
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
  console.log("\nAll CompileDraft tests passed.");
})();
