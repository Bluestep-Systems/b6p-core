// Behavioral spec for the build manifest (contract v1): where it lives, which files are sources, its hashes and format,
// when none is written, and the publish check's refusals mapped to typed errors. The pure functions are checked directly;
// the commit and publish paths run against the platform stand-in (support/GitProxyStub.js), whose check is written
// independently of the client. Dependency-free node script over the COMPILED dist/ (run via `npm test`).

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createStub } = require("./support/GitProxyStub");
const lib = require("../dist/index.js");

const AUTHOR = { name: "Ada Tester", email: "ada@example.test" };
let failures = 0;
const pending = [];
function test(name, fn) {
  pending.push([name, fn]);
}
const tsconfig = (outDir) => (outDir === undefined ? "{}" : JSON.stringify({ compilerOptions: { outDir } }));

// ── §1 where the file is ──────────────────────────────────────────────

test("manifest path: every row of the contract's examples table", () => {
  const rows = [
    [undefined, ".build/.b6p-build.json"],
    ['"dist"', "dist/.b6p-build.json"],
    ['"./dist/"', "dist/.b6p-build.json"],
    ['""', ".b6p-build.json"],
    ['"."', ".b6p-build.json"],
    ['"./"', ".b6p-build.json"],
    ['"../out"', ".b6p-build.json"],
    ['"/abs"', ".b6p-build.json"],
  ];
  for (const [outDir, expected] of rows) {
    const text = outDir === undefined ? "{}" : `{"compilerOptions":{"outDir":${outDir}}}`;
    assert.strictEqual(lib.buildManifestPath(lib.buildOutputFolder(text)), expected, `outDir ${outDir}`);
  }
});

test("manifest path: the rest of §1 (comments, trailing commas, no extends, bad values, trailing slashes, jsconfig)", () => {
  const folder = lib.buildOutputFolder;
  assert.strictEqual(folder('{\n // c\n "compilerOptions": { /* x */ "outDir": "out", },\n}'), "out");
  assert.strictEqual(folder('{"compilerOptions":{"outDir":"a//"}}'), "a");
  assert.strictEqual(folder('{"compilerOptions":{"outDir":"build/out/"}}'), "build/out");
  assert.strictEqual(folder('{"compilerOptions":{"outDir":"a/../b"}}'), "", "a .. segment");
  assert.strictEqual(folder('{"compilerOptions":{"outDir":"a\\\\b"}}'), "", "a backslash");
  assert.strictEqual(folder('{"compilerOptions":{"outDir":"./."}}'), "", "only dots and slashes");
  assert.strictEqual(folder('{"compilerOptions":{"outDir":5}}'), ".build", "not a string: absent");
  assert.strictEqual(folder("{ not json"), ".build", "does not parse: absent");
  assert.strictEqual(folder('{"extends":"./base.json","compilerOptions":{}}'), ".build", "extends is not followed");
  assert.strictEqual(folder(undefined), ".build", "no config: absent");
  assert.strictEqual(
    folder('{"compilerOptions":{"outDir":"http://x"}}'),
    "http://x",
    "a // inside a string is not a comment"
  );
  assert.strictEqual(folder('﻿{"compilerOptions":{"outDir":"dist"}}'), "dist", "a byte order mark");
});

// ── §2 which files are sources ────────────────────────────────────────

test("sources: extensions by the last dot, any case, .d.ts counts, no extension does not", () => {
  const src = (p, folder = ".build") => lib.isBuildSource(p, folder);
  for (const p of [
    "a.ts",
    "a.tsx",
    "a.mts",
    "a.cts",
    "a.js",
    "a.jsx",
    "a.mjs",
    "a.cjs",
    "a.json",
    "a.jsonc",
    "x/y/types.d.ts",
    "A.TS",
    "b.Js",
    "tsconfig.json",
    "jsconfig.json",
    "package.json",
    "sub/tsconfig.json",
  ]) {
    assert.strictEqual(src(p), true, p);
  }
  for (const p of [
    "README.md",
    "index.html",
    "a.css",
    "logo.png",
    "LICENSE",
    "scripts/Makefile",
    ".gitignore",
    "a.ts.map",
    "a.d.ts.bak",
  ]) {
    assert.strictEqual(src(p), false, p);
  }
});

test("sources: not the manifest, and nothing under the output folder", () => {
  assert.strictEqual(lib.isBuildSource(".build/app.js", ".build"), false);
  assert.strictEqual(lib.isBuildSource(".build/.b6p-build.json", ".build"), false);
  assert.strictEqual(lib.isBuildSource(".buildx/app.js", ".build"), true, "a sibling whose name only starts the same");
  assert.strictEqual(lib.isBuildSource("scripts/.build/app.js", ".build"), true, "a nested .build is outside M");
  assert.strictEqual(lib.isBuildSource("dist/a/b.js", "dist"), false);
});

test("sources: in-place output sits beside its sources and counts; a nested outDir outside M counts too", () => {
  assert.strictEqual(lib.isBuildSource("scripts/app.js", ""), true, "in-place: emitted .js is a source");
  assert.strictEqual(lib.isBuildSource(".b6p-build.json", ""), false, "the manifest at the root is not");
  assert.strictEqual(
    lib.isBuildSource("client/.build/script.js", ".build"),
    true,
    "a nested tsconfig's output lies outside M"
  );
  assert.strictEqual(lib.isBuildSource("client/dist/script.js", "dist"), true);
});

// ── §3 hashes and format ──────────────────────────────────────────────

test("hashes equal git hash-object, and the text is sorted, two-space, newline-terminated, version 1", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bm-hash-"));
  const cases = ["", "hello\n", "tab\tand é bytes\r\n", "a".repeat(100_000)];
  for (const [i, text] of cases.entries()) {
    const file = path.join(tmp, `f${i}`);
    fs.writeFileSync(file, text);
    const expected = execFileSync("git", ["hash-object", file], { encoding: "utf8" }).trim();
    assert.strictEqual(await lib.gitBlobSha1(new Uint8Array(fs.readFileSync(file))), expected);
  }
  assert.strictEqual(await lib.gitBlobSha1(new Uint8Array()), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  fs.rmSync(tmp, { recursive: true, force: true });

  const text = lib.formatBuildManifest({ "scripts/app.ts": "b".repeat(40), "package.json": "a".repeat(40) });
  assert.strictEqual(text.endsWith("}\n"), true);
  const parsed = JSON.parse(text);
  assert.strictEqual(parsed.version, 1);
  assert.deepStrictEqual(Object.keys(parsed.sources), ["package.json", "scripts/app.ts"]);
  assert.ok(text.includes('\n    "package.json": "' + "a".repeat(40) + '"'), "two-space indent");
});

test("planBuildManifest: hashes come from the tree as committed; the manifest and outputs are left out", async () => {
  const tree = [
    { path: "tsconfig.json", oid: "1".repeat(40) },
    { path: "scripts/app.ts", oid: "2".repeat(40) },
    { path: ".build/scripts/app.js", oid: "3".repeat(40) },
    { path: ".build/.b6p-build.json", oid: "4".repeat(40) },
    { path: "README.md", oid: "5".repeat(40) },
  ];
  const plan = await lib.planBuildManifest(tree, async (p) =>
    p === "tsconfig.json" ? new TextEncoder().encode("{}") : undefined
  );
  assert.strictEqual(plan.path, ".build/.b6p-build.json");
  assert.deepStrictEqual(JSON.parse(plan.content).sources, {
    "scripts/app.ts": "2".repeat(40),
    "tsconfig.json": "1".repeat(40),
  });
});

test("exempt: an externally built script, and a tree with no tsconfig.json at any depth, get no manifest", async () => {
  const none = async () => undefined;
  assert.strictEqual(
    await lib.planBuildManifest([{ path: "tsconfig.json", oid: "1".repeat(40) }], none, { externallyBuilt: true }),
    undefined
  );
  assert.strictEqual(await lib.planBuildManifest([{ path: "scripts/app.js", oid: "1".repeat(40) }], none), undefined);
  assert.notStrictEqual(
    await lib.planBuildManifest([{ path: "client/tsconfig.json", oid: "1".repeat(40) }], none),
    undefined,
    "a nested tsconfig counts"
  );
});

// ── commit and publish against the stand-in ───────────────────────────

const stub = createStub();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bm-work-"));
let baseUrl;
let n = 0;
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
const SEED = { "tsconfig.json": tsconfig(), "scripts/app.ts": "export const v = 1;\n" };
const read = (repo, rel) => fs.readFileSync(path.join(repo.dir, rel), "utf8");

test("commit with the manifest: published as it is; its hashes are what git ls-tree shows", async () => {
  stub.addRepo("654015___7201", { files: SEED });
  const repo = repoFor("654015___7201");
  await repo.clone();
  await repo.writeFile("scripts/app.ts", "export const v = 2;\n");
  await repo.writeFile(".build/scripts/app.js", "exports.v = 2;\n");
  assert.ok(await repo.commit("build", AUTHOR, { buildManifest: {} }));
  const manifest = JSON.parse(read(repo, ".build/.b6p-build.json"));
  const tree = new Map((await repo.listTree("draft")).map((f) => [f.path, f.oid]));
  assert.deepStrictEqual(Object.keys(manifest.sources), ["scripts/app.ts", "tsconfig.json"]);
  for (const [p, oid] of Object.entries(manifest.sources)) {
    assert.strictEqual(oid, tree.get(p), p);
  }
  await repo.push();
  assert.strictEqual((await repo.publish()).publishedSha, await repo.sha("draft"));
  // Committing again with nothing changed writes nothing new.
  assert.strictEqual(await repo.commit("again", AUTHOR, { buildManifest: {} }), undefined);
});

test("a source changed without a rebuild: the publish is refused BUILD_STALE with the stale paths; rebuilding fixes it", async () => {
  stub.addRepo("654015___7202", { files: SEED });
  const repo = repoFor("654015___7202");
  await repo.clone();
  await repo.writeFile(".build/scripts/app.js", "exports.v = 1;\n");
  await repo.commit("build", AUTHOR, { buildManifest: {} });
  await repo.push();
  await repo.publish();

  await repo.writeFile("scripts/app.ts", "export const v = 3;\n");
  await repo.writeFile("scripts/new.ts", "export {};\n");
  await repo.commit("edit without a build", AUTHOR);
  await repo.push();
  const masterBefore = stub.git(stub.repos.get("654015___7202").bare, "rev-parse", "master");
  await rejects(repo.publish(), lib.PublishBuildStaleError, (e) => {
    assert.ok(e instanceof lib.PublishRefusedError);
    assert.strictEqual(e.reason, "BUILD_STALE");
    assert.deepStrictEqual(e.withheld, ["scripts/app.ts", "scripts/new.ts"]);
  });
  assert.strictEqual(
    stub.git(stub.repos.get("654015___7202").bare, "rev-parse", "master"),
    masterBefore,
    "nothing was promoted"
  );

  await repo.commit("rebuild", AUTHOR, { buildManifest: {}, parents: [await repo.sha("draft")] });
  await repo.push();
  await repo.publish();
});

test("a failed or partial build leaves the existing manifest exactly as it was (so it goes stale)", async () => {
  stub.addRepo("654015___7203", { files: SEED });
  const repo = repoFor("654015___7203");
  await repo.clone();
  await repo.commit("build", AUTHOR, { buildManifest: {}, parents: [await repo.sha("draft")] });
  const before = read(repo, ".build/.b6p-build.json");
  await repo.writeFile("scripts/app.ts", "export const broken = ;\n");
  await repo.commit("the build failed: no buildManifest option", AUTHOR);
  assert.strictEqual(read(repo, ".build/.b6p-build.json"), before);
  assert.strictEqual(new TextDecoder().decode(await repo.readFile("draft", ".build/.b6p-build.json")), before);
  await repo.push();
  await rejects(repo.publish(), lib.PublishBuildStaleError);
});

test("no tsconfig.json: no manifest is written and the publish is not checked; externally built: none either", async () => {
  stub.addRepo("654015___7204", { files: { "scripts/app.js": "exports.v = 1;\n" } });
  const plain = repoFor("654015___7204");
  await plain.clone();
  await plain.writeFile("scripts/app.js", "exports.v = 2;\n");
  await plain.commit("edit", AUTHOR, { buildManifest: {} });
  assert.ok(!fs.existsSync(path.join(plain.dir, ".build", ".b6p-build.json")));
  await plain.push();
  await plain.publish();

  stub.addRepo("654015___7205", { files: SEED });
  stub.repos.get("654015___7205").externallyBuilt = true;
  const external = repoFor("654015___7205");
  await external.clone();
  await external.writeFile("scripts/app.ts", "export const v = 9;\n");
  await external.commit("bundled elsewhere", AUTHOR, { buildManifest: { externallyBuilt: true } });
  assert.ok(!fs.existsSync(path.join(external.dir, ".build", ".b6p-build.json")));
  await external.push();
  await external.publish();
});

test("a nested outDir and in-place output follow §1/§2 through a real commit", async () => {
  stub.addRepo("654015___7206", { files: { "tsconfig.json": tsconfig("./dist/"), "scripts/app.ts": "export {};\n" } });
  const dist = repoFor("654015___7206");
  await dist.clone();
  await dist.writeFile("dist/scripts/app.js", "x\n");
  await dist.writeFile("client/.build/script.js", "client output\n");
  await dist.commit("build", AUTHOR, { buildManifest: {} });
  const m = JSON.parse(read(dist, "dist/.b6p-build.json"));
  assert.deepStrictEqual(Object.keys(m.sources), ["client/.build/script.js", "scripts/app.ts", "tsconfig.json"]);
  await dist.push();
  await dist.publish();

  stub.addRepo("654015___7207", { files: { "tsconfig.json": tsconfig("."), "scripts/app.ts": "export {};\n" } });
  const inPlace = repoFor("654015___7207");
  await inPlace.clone();
  await inPlace.writeFile("scripts/app.js", "emitted\n");
  await inPlace.commit("build", AUTHOR, { buildManifest: {} });
  assert.deepStrictEqual(Object.keys(JSON.parse(read(inPlace, ".b6p-build.json")).sources), [
    "scripts/app.js",
    "scripts/app.ts",
    "tsconfig.json",
  ]);
  await inPlace.push();
  await inPlace.publish();
  await inPlace.writeFile("scripts/app.js", "edited by hand\n");
  await inPlace.commit("hand edit of an output", AUTHOR);
  await inPlace.push();
  await rejects(inPlace.publish(), lib.PublishBuildStaleError, (e) =>
    assert.deepStrictEqual(e.withheld, ["scripts/app.js"])
  );
});

test("a tsconfig with no manifest is BUILD_MANIFEST_MISSING; a manifest that does not parse is BUILD_MANIFEST_INVALID", async () => {
  stub.addRepo("654015___7208", { files: SEED });
  const repo = repoFor("654015___7208");
  await repo.clone();
  await rejects(repo.publish(), lib.PublishBuildManifestMissingError, (e) => {
    assert.strictEqual(e.reason, "BUILD_MANIFEST_MISSING");
    assert.deepStrictEqual(e.withheld, [".build/.b6p-build.json"]);
  });
  await repo.writeFile(".build/.b6p-build.json", "{ not json");
  await repo.commit("garbage", AUTHOR);
  await repo.push();
  await rejects(repo.publish(), lib.PublishBuildManifestInvalidError, (e) => {
    assert.strictEqual(e.reason, "BUILD_MANIFEST_INVALID");
    assert.deepStrictEqual(e.withheld, [".build/.b6p-build.json"]);
  });
  await repo.writeFile(".build/.b6p-build.json", JSON.stringify({ version: 2, sources: {} }));
  await repo.commit("wrong version", AUTHOR);
  await repo.push();
  await rejects(repo.publish(), lib.PublishBuildManifestInvalidError);
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
  console.log("\nAll BuildManifest tests passed.");
})();
