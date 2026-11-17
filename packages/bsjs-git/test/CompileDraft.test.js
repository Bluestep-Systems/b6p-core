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
  assert.deepStrictEqual(result.fastForward, { state: "fast-forwarded", blockedPaths: [], error: null });
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

test("a build whose answer was lost (a 503 after the commit): the retry is the platform's repeat call and the folder still fast-forwards", async () => {
  const { repo, entry } = await pushed();
  const pushedSha = await repo.sha("draft");
  entry.buildQueue = ["BUILD_THEN_NETWORK"];
  const { waits, sleep } = noSleep();
  const result = await repo.compileDraft({ sleep });
  assert.deepStrictEqual(waits, [2_000]);
  assert.strictEqual(result.fastForward.state, "fast-forwarded");
  assert.strictEqual(await repo.sha("draft"), result.buildCommitSha);
  assert.strictEqual(stub.git(entry.bare, "rev-parse", "draft^"), pushedSha, "one build commit, on the pushed one");
  assert.strictEqual(stub.state.buildInputs.at(-1).expectedDraftSha, pushedSha, "the retry asks for the same commit");
  assert.deepStrictEqual(await repo.status(), []);
});

test("a BUSY answer from a build that committed anyway: the retry finds the build and takes it", async () => {
  const { repo, entry } = await pushed();
  entry.buildQueue = ["BUILD_THEN_BUSY"];
  const result = await repo.compileDraft(noSleep());
  assert.strictEqual(result.compile.status, "COMPILED");
  assert.strictEqual(result.fastForward.state, "fast-forwarded");
  assert.strictEqual(stub.git(entry.bare, "rev-parse", "draft"), result.buildCommitSha);
});

test("the fast-forward keeps a local edit to a file the build does not touch", async () => {
  const { repo } = await pushed();
  await repo.writeFile("notes.txt", "mine\n");
  await repo.writeFile("tsconfig.json", '{ "compilerOptions": {} }');
  const result = await repo.compileDraft();
  assert.strictEqual(result.fastForward.state, "fast-forwarded");
  assert.strictEqual(fs.readFileSync(path.join(repo.dir, "notes.txt"), "utf8"), "mine\n");
  assert.strictEqual(fs.readFileSync(path.join(repo.dir, "tsconfig.json"), "utf8"), '{ "compilerOptions": {} }');
  assert.deepStrictEqual(
    (await repo.status()).map((c) => c.path).sort(),
    ["notes.txt", "tsconfig.json"],
    "only the local edits differ from the build commit"
  );
});

test("a local edit to an output the build changes blocks the fast-forward: ref, index and tree stay, and it says which paths", async () => {
  const { repo, entry } = await pushed();
  await repo.compileDraft();
  await repo.writeFile("scripts/app.ts", "export const v = 5;\n");
  await repo.commit("edit", AUTHOR);
  await repo.push();
  const pushedSha = await repo.sha("draft");
  await repo.writeFile(".build/scripts/app.js", "// mine\n");
  const result = await repo.compileDraft();
  assert.strictEqual(result.fastForward.state, "blocked");
  assert.deepStrictEqual(result.fastForward.blockedPaths, [".build/scripts/app.js"], "the manifest is untouched here");
  assert.ok(result.buildCommitSha, "the build happened on the platform");
  assert.strictEqual(result.head, pushedSha);
  assert.strictEqual(await repo.sha("draft"), pushedSha, "the ref did not move");
  assert.strictEqual(fs.readFileSync(path.join(repo.dir, ".build/scripts/app.js"), "utf8"), "// mine\n");
  assert.deepStrictEqual(
    (await repo.status()).map((c) => c.path),
    [".build/scripts/app.js"],
    "the index is still the pushed commit's"
  );
  assert.strictEqual(stub.git(entry.bare, "rev-parse", "draft"), result.buildCommitSha);
});

test("an ignored stale output blocks the fast-forward; once it is gone the build comes in, staged, and the next push keeps it", async () => {
  const { repo, entry } = await pushed({ ...SEED, ".gitignore": ".build/\n" });
  const pushedSha = await repo.sha("draft");
  await repo.writeFile(".build/scripts/app.js", "// from a local tsc\n");
  const blocked = await repo.compileDraft();
  assert.strictEqual(blocked.fastForward.state, "blocked");
  assert.deepStrictEqual(blocked.fastForward.blockedPaths, [".build/scripts/app.js"]);
  assert.strictEqual(await repo.sha("draft"), pushedSha);

  fs.rmSync(path.join(repo.dir, ".build"), { recursive: true });
  const moved = await repo.fastForwardToBuild(blocked.buildCommitSha);
  assert.strictEqual(moved.state, "fast-forwarded");
  assert.strictEqual(await repo.sha("draft"), blocked.buildCommitSha);
  assert.deepStrictEqual(await repo.status(), [], "the ignored output is in the index as the build committed it");

  await repo.writeFile("scripts/app.ts", "export const v = 6;\n");
  await repo.commit("next", AUTHOR);
  await repo.push();
  const tree = stub.git(entry.bare, "ls-tree", "-r", "--name-only", "draft").split("\n");
  assert.ok(tree.includes(".build/scripts/app.js") && tree.includes(".build/.b6p-build.json"), "nothing was deleted");
});

test("an ignored local file that already matches the build does not block it", async () => {
  const { repo } = await pushed({ ...SEED, ".gitignore": ".build/\n" });
  const source = (await repo.listTree("draft")).find((f) => f.path === "scripts/app.ts");
  // What the stand-in's build writes for that source.
  await repo.writeFile(".build/scripts/app.js", `// built from scripts/app.ts ${source.oid}\n`);
  const result = await repo.compileDraft();
  assert.strictEqual(result.fastForward.state, "fast-forwarded");
  assert.deepStrictEqual(await repo.status(), []);
});

test("isBuildCommitOf: the trailer names the source, one parent, output only; the subject alone never counts", async () => {
  const { repo, entry } = await pushed();
  const pushedSha = await repo.sha("draft");
  const result = await repo.compileDraft();
  assert.strictEqual(await repo.isBuildCommitOf(result.buildCommitSha, pushedSha), true);
  const other = pushedSha.startsWith("0") ? `1${pushedSha.slice(1)}` : `0${pushedSha.slice(1)}`;
  assert.strictEqual(await repo.isBuildCommitOf(result.buildCommitSha, other), false, "another source");
  assert.strictEqual(
    stub.git(entry.bare, "log", "-1", "--format=%(trailers:key=Bluestep-Build-Of,valueonly)", result.buildCommitSha),
    pushedSha
  );

  const forge = (message, file, text) => {
    const work = fs.mkdtempSync(path.join(tmp, "forge-"));
    stub.git(tmp, "clone", "-q", "-b", "draft", entry.bare, work);
    fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
    fs.writeFileSync(path.join(work, file), text);
    stub.git(work, "add", "-A", "-f");
    stub.git(work, "-c", "user.name=P", "-c", "user.email=p@x", "commit", "-q", ...message.flatMap((m) => ["-m", m]));
    stub.git(work, "push", "-q", entry.bare, "draft");
    return stub.git(work, "rev-parse", "HEAD");
  };
  const base = result.buildCommitSha;
  const subjectOnly = forge(["Build draft"], ".build/scripts/app.js", "// by hand\n");
  await repo.fetch();
  assert.strictEqual(await repo.isBuildCommitOf(subjectOnly, base), false, "a build's subject without the trailer");
  const sourceEdit = forge(
    ["Build draft", `Bluestep-Build-Of: ${subjectOnly}`],
    "scripts/app.ts",
    "export const v = 99;\n"
  );
  await repo.fetch();
  assert.strictEqual(await repo.isBuildCommitOf(sourceEdit, subjectOnly), false, "the trailer on a source edit");
  assert.strictEqual(lib.buildSourceOf(`Build draft\n\nBluestep-Build-Of: ${pushedSha}\n`), pushedSha);
});

test("a chain of two builds of the pushed commit (a lost answer, then a rebuild) is recognised and fast-forwards", async () => {
  const { repo, entry } = await pushed();
  const pushedSha = await repo.sha("draft");
  entry.buildQueue = ["BUILD_THEN_NETWORK"];
  let calls = 0;
  entry.beforeBuild = () => {
    // The retry rebuilds differently (unclean), on top of the first build: a second build commit.
    if (++calls === 2) {
      entry.buildUnclean = true;
    }
  };
  const result = await repo.compileDraft(noSleep());
  const first = stub.git(entry.bare, "rev-parse", "draft^");
  assert.notStrictEqual(first, pushedSha, "two build commits");
  assert.strictEqual(stub.git(entry.bare, "rev-parse", "draft^^"), pushedSha);
  assert.strictEqual(await repo.isBuildCommitOf(result.buildCommitSha, pushedSha), true);
  assert.strictEqual(await repo.isBuildCommitOf(result.buildCommitSha, first), false, "the source is the pushed sha");
  assert.strictEqual(result.fastForward.state, "fast-forwarded");
  assert.strictEqual(result.vouched, false);
  assert.ok(!fs.existsSync(path.join(repo.dir, ".build", ".b6p-build.json")), "the rebuild's manifest deletion");
  assert.deepStrictEqual(await repo.status(), []);
});

test("an unvouched rebuild deletes the manifest: the fast-forward removes it from the folder and the index", async () => {
  const { repo, entry } = await pushed();
  await repo.compileDraft();
  assert.ok(fs.existsSync(path.join(repo.dir, ".build", ".b6p-build.json")));
  await repo.writeFile("scripts/app.ts", "export const v = 7;\n");
  await repo.commit("edit", AUTHOR);
  await repo.push();
  entry.buildUnclean = true;
  const result = await repo.compileDraft();
  assert.strictEqual(result.fastForward.state, "fast-forwarded");
  assert.ok(!fs.existsSync(path.join(repo.dir, ".build", ".b6p-build.json")));
  assert.deepStrictEqual(await repo.status(), []);
});

test("buildSourceOf mirrors web's buildTrailer exactly (DraftBuildRefusalTest), case by case", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const BUILT = "89abcdef0123456789abcdef0123456789abcdef";
  const sha256 = SHA + SHA.slice(0, 24);
  const t = lib.buildSourceOf;
  assert.strictEqual(t(`Build draft\n\nBluestep-Build-Of: ${SHA}\n`), SHA, "the message web writes");
  assert.strictEqual(t(`Build draft\r\n\r\nSigned-off-by: a\r\nBluestep-Build-Of: ${SHA}\r\n\r\n`), SHA, "CRLF");
  assert.strictEqual(t(`x\n\nBluestep-Build-Of: ${sha256}`), sha256, "a 64-hex id");
  assert.strictEqual(t(`Bluestep-Build-Of: ${SHA}`), SHA, "no blank line: the whole message is the last paragraph");
  assert.strictEqual(t(`Bluestep-Build-Of: ${SHA}  \n \n`), SHA, "the message's trailing whitespace is dropped");
  assert.strictEqual(t(`x\n\nBluestep-Build-Of: ${SHA} \nOther: y`), null, "a space ending the line, mid-paragraph");
  assert.strictEqual(t("Build draft"), null, "the subject alone never counts");
  assert.strictEqual(t(`Bluestep-Build-Of: ${SHA}\n\nmore text`), null, "not in the last paragraph");
  assert.strictEqual(t(`x\n\nBluestep-Build-Of: ${SHA.slice(0, 12)}`), null, "abbreviated");
  assert.strictEqual(t(`x\n\nBluestep-Build-Of: ${SHA.toUpperCase()}`), null, "an upper-case id");
  assert.strictEqual(t(`x\n\nBluestep-Build-Of: ${SHA} extra`), null, "trailing text");
  assert.strictEqual(t(`x\n\nbluestep-build-of: ${SHA}`), null, "a wrong-case key");
  assert.strictEqual(t(`x\n\nBluestep-Build-Of:  ${SHA}`), null, "two spaces");
  assert.strictEqual(t(`x\n\nBluestep-Build-Of :${SHA}`), null, "a space before the colon");
  assert.strictEqual(t(`x\n\n Bluestep-Build-Of: ${SHA}`), null, "leading space");
  assert.strictEqual(t(`x\n\nBluestep-Build-Of: ${SHA}\nBluestep-Build-Of: ${BUILT}`), null, "two trailers");
});

test("buildSourceOf: a whitespace-only line separates paragraphs, as git interpret-trailers reads it (ruling 67)", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const OTHER = "89abcdef0123456789abcdef0123456789abcdef";
  const t = lib.buildSourceOf;
  assert.strictEqual(t(`Bluestep-Build-Of: ${SHA}\n \nordinary text`), null, "a space-only line ends its paragraph");
  assert.strictEqual(t(`x\n\nBluestep-Build-Of: ${SHA}\n\t\nBluestep-Build-Of: ${OTHER}`), OTHER, "only the last");
  assert.strictEqual(t(`Build draft\n \nBluestep-Build-Of: ${SHA}`), SHA);
  assert.strictEqual(t(`Build draft\r\n\t \r\nBluestep-Build-Of: ${SHA}\r\n`), SHA, "CRLF and a tab-space line");
});

test("rule 3 over every project: each tsconfig.json at any depth gives <dir>/<folder>, the root jsconfig only without a root tsconfig", () => {
  const cfg = (outDir) => (outDir === undefined ? "{}" : JSON.stringify({ compilerOptions: { outDir } }));
  const folders = (configs) => lib.buildOutputFolders(configs.map(([path, text]) => ({ path, text })));
  assert.deepStrictEqual(lib.buildConfigPaths(["a.ts", "tsconfig.json", "client/tsconfig.json", "jsconfig.json"]), [
    "client/tsconfig.json",
    "tsconfig.json",
  ]);
  assert.deepStrictEqual(
    lib.buildConfigPaths(["jsconfig.json", "x/jsconfig.json", "a/b/tsconfig.json"]),
    ["a/b/tsconfig.json", "jsconfig.json"],
    "a root jsconfig without a root tsconfig counts; a nested jsconfig never does"
  );
  assert.deepStrictEqual(
    folders([
      ["tsconfig.json", cfg()],
      ["client/tsconfig.json", cfg("./dist/")],
    ]),
    [".build", "client/dist"]
  );
  assert.deepStrictEqual(
    folders([
      ["tsconfig.json", cfg(".")],
      ["lib/tsconfig.json", cfg("../out")],
    ]),
    [],
    "empty, leaving"
  );
  const r = lib.changesOnlyBuildOutput;
  const two = folders([
    ["tsconfig.json", cfg()],
    ["client/tsconfig.json", cfg()],
  ]);
  assert.strictEqual(r([".build/scripts/app.js", ".build/.b6p-build.json"], two), true, "the root project");
  assert.strictEqual(r(["client/.build/script.js"], two), true, "a nested project's output");
  assert.strictEqual(r(["client/.build/script.js", ".build/a.js"], two), true, "both at once");
  assert.strictEqual(r(["client/main.js"], two), false, "outside every project's folder");
  assert.strictEqual(r([".buildx/a.js"], two), false, "only the folder itself");
  assert.strictEqual(r(["scripts/app.js"], []), false, "no folders: nothing is a build");
  assert.strictEqual(r([], two), true, "no change is under a folder, as web's allMatch");
});

test("a nested project's build is recognised; a change outside every project's folder is not", async () => {
  const { repo, entry } = await pushed({ ...SEED, "client/tsconfig.json": "{}", "client/main.ts": "export {};\n" });
  const base = await repo.sha("draft");
  const forge = (file, text) => {
    const work = fs.mkdtempSync(path.join(tmp, "nested-"));
    stub.git(tmp, "clone", "-q", "-b", "draft", entry.bare, work);
    fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
    fs.writeFileSync(path.join(work, file), text);
    stub.git(work, "add", "-A", "-f");
    stub.git(
      work,
      "-c",
      "user.name=P",
      "-c",
      "user.email=p@x",
      "commit",
      "-q",
      "-m",
      "Build draft",
      "-m",
      `Bluestep-Build-Of: ${base}`
    );
    const sha = stub.git(work, "rev-parse", "HEAD");
    stub.git(work, "push", "-q", "-f", entry.bare, "HEAD:draft");
    return sha;
  };
  const nested = forge("client/.build/main.js", "// built\n");
  await repo.fetch();
  assert.strictEqual(await repo.isBuildCommitOf(nested, base), true);
  stub.git(entry.bare, "update-ref", "refs/heads/draft", base);
  const outside = forge("client/main.js", "// not output\n");
  await repo.fetch();
  assert.strictEqual(await repo.isBuildCommitOf(outside, base), false);
  stub.git(entry.bare, "update-ref", "refs/heads/draft", base);
});

test("a build commit is judged on complete tree entries: a mode change or a gitlink outside F is not a build", async () => {
  const { repo, entry } = await pushed();
  const base = (await repo.compileDraft()).buildCommitSha;
  const forge = (setup) => {
    const work = fs.mkdtempSync(path.join(tmp, "entries-"));
    stub.git(tmp, "clone", "-q", "-b", "draft", entry.bare, work);
    setup(work);
    stub.git(
      work,
      "-c",
      "user.name=P",
      "-c",
      "user.email=p@x",
      "commit",
      "-q",
      "-m",
      "Build draft",
      "-m",
      `Bluestep-Build-Of: ${base}`
    );
    const sha = stub.git(work, "rev-parse", "HEAD");
    stub.git(work, "push", "-q", "-f", entry.bare, "HEAD:draft");
    return sha;
  };
  const modeOnly = forge((w) => stub.git(w, "update-index", "--chmod=+x", "scripts/app.ts"));
  await repo.fetch();
  assert.strictEqual(await repo.isBuildCommitOf(modeOnly, base), false, "a mode-only change outside F");
  stub.git(entry.bare, "update-ref", "refs/heads/draft", base);
  const gitlink = forge((w) => stub.git(w, "update-index", "--add", "--cacheinfo", `160000,${base},vendor/lib`));
  await repo.fetch();
  assert.strictEqual(await repo.isBuildCommitOf(gitlink, base), false, "a submodule outside F");
  stub.git(entry.bare, "update-ref", "refs/heads/draft", base);
  const insideMode = forge((w) => stub.git(w, "update-index", "--chmod=+x", ".build/scripts/app.js"));
  await repo.fetch();
  assert.strictEqual(await repo.isBuildCommitOf(insideMode, base), true, "a mode change under F is output");
  stub.git(entry.bare, "update-ref", "refs/heads/draft", base);
});

test("an unknown build outcome is never retried: the draft is read back, and a build of the push is taken in", async () => {
  const { repo, entry } = await pushed();
  const pushedSha = await repo.sha("draft");
  entry.buildQueue = ["OUTCOME_UNKNOWN_BUILT"];
  const before = stub.state.buildInputs.length;
  const found = await repo.compileDraft(noSleep());
  assert.strictEqual(stub.state.buildInputs.length, before + 1, "one request, no retry");
  assert.deepStrictEqual(found.outcomeUnknown, { buildFound: true });
  assert.deepStrictEqual([found.compile.status, found.compile.rawStatus], ["UNKNOWN", "BUILD_OUTCOME_UNKNOWN"]);
  assert.strictEqual(found.fastForward.state, "fast-forwarded");
  assert.strictEqual(found.buildCommitSha, stub.git(entry.bare, "rev-parse", "draft"));
  assert.notStrictEqual(found.buildCommitSha, pushedSha);
  assert.strictEqual(await repo.sha("draft"), found.buildCommitSha);
  assert.strictEqual(found.vouched, false, "how the build went is not known");

  const other = await pushed();
  other.entry.buildQueue = ["OUTCOME_UNKNOWN"];
  const head = await other.repo.sha("draft");
  const missing = await other.repo.compileDraft(noSleep());
  assert.deepStrictEqual(missing.outcomeUnknown, { buildFound: false });
  assert.deepStrictEqual([missing.buildCommitSha, missing.head], [null, head]);
  assert.strictEqual(stub.git(other.entry.bare, "rev-parse", "draft"), head, "nothing was built by a retry");
});

test("a refusal carries web's DraftBuildRefusalReason, typed; none is retried", async () => {
  for (const reason of ["DRAFT_TOO_LARGE", "REPO_MISSING", "DRAFT_BRANCH_MISSING", "SOMETHING_NEWER"]) {
    const { repo, entry } = await pushed();
    entry.buildQueue = [`REFUSE:${reason}`];
    const before = stub.state.buildInputs.length;
    const { waits, sleep } = noSleep();
    await rejects(repo.compileDraft({ sleep }), lib.DraftBuildFailedError, (e) => {
      assert.strictEqual(e.rawReason, reason);
      assert.strictEqual(e.reason, reason === "SOMETHING_NEWER" ? null : reason);
      assert.strictEqual(e.networkFailure, false);
    });
    assert.strictEqual(stub.state.buildInputs.length, before + 1, `${reason}: one request`);
    assert.deepStrictEqual(waits, []);
  }
  assert.deepStrictEqual([...lib.DRAFT_BUILD_REFUSAL_REASONS].sort(), [
    "BUILD_OUTCOME_UNKNOWN",
    "DRAFT_BRANCH_MISSING",
    "DRAFT_MOVED",
    "DRAFT_TOO_LARGE",
    "REPO_MISSING",
  ]);
  assert.strictEqual(new lib.DraftBuildMovedError(null, "m").reason, "DRAFT_MOVED");
  assert.strictEqual(new lib.DraftBuildOutcomeUnknownError(null, "m").reason, "BUILD_OUTCOME_UNKNOWN");
});

test("a pinned publish: the build commit, or the pushed commit the local draft is a build of; anything else is refused unsent", async () => {
  const { repo, entry } = await pushed();
  const pushedSha = await repo.sha("draft");
  const build = await repo.compileDraft();
  assert.strictEqual((await repo.publish({ at: build.buildCommitSha })).publishedSha, build.buildCommitSha);
  assert.strictEqual((await repo.publish({ at: pushedSha })).publishedSha, build.buildCommitSha, "a build of it");

  // A later save moves the draft to C: publishing it under B's build result is refused before any request.
  await repo.writeFile("scripts/app.ts", "export const v = 8;\n");
  await repo.commit("a concurrent save", AUTHOR);
  await repo.push();
  const sent = stub.state.publishInputs.length;
  await rejects(repo.publish({ at: build.buildCommitSha }), lib.PublishPinMismatchError, (e) => {
    assert.strictEqual(e.code, "PUBLISH_PIN_MISMATCH");
    assert.strictEqual(e.at, build.buildCommitSha);
    assert.strictEqual(e.local, stub.git(entry.bare, "rev-parse", "draft"));
  });
  assert.strictEqual(stub.state.publishInputs.length, sent, "nothing was sent");
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
