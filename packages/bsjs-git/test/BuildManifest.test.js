// Behavioral spec for the build manifest (contract v1): where it lives, which files are sources, and the publish check's
// refusals mapped to typed errors. The client never writes a manifest (the platform's build does, see
// CompileDraft.test.js); the pure layout rules are checked directly, and the publish paths run against the platform
// stand-in (support/GitProxyStub.js), whose build and check are written independently of the client. Dependency-free
// node script over the COMPILED dist/ (run via `npm test`).

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

/** Push what is committed, then have the platform build it. */
async function pushAndBuild(repo) {
  await repo.push();
  return repo.compileDraft();
}

test("the platform's clean build: its manifest lists the committed sources by blob id, and it publishes", async () => {
  stub.addRepo("654015___7201", { files: SEED });
  const repo = repoFor("654015___7201");
  await repo.clone();
  await repo.writeFile("scripts/app.ts", "export const v = 2;\n");
  await repo.commit("edit", AUTHOR);
  const build = await pushAndBuild(repo);
  assert.strictEqual(build.vouched, true);
  const manifest = JSON.parse(read(repo, ".build/.b6p-build.json"));
  const tree = new Map((await repo.listTree("draft")).map((f) => [f.path, f.oid]));
  assert.deepStrictEqual(Object.keys(manifest.sources), ["scripts/app.ts", "tsconfig.json"]);
  for (const [p, oid] of Object.entries(manifest.sources)) {
    assert.strictEqual(oid, tree.get(p), p);
  }
  assert.strictEqual((await repo.publish()).publishedSha, build.buildCommitSha);
});

test("a source pushed without a build: the publish is refused BUILD_STALE with the stale paths; a build fixes it", async () => {
  stub.addRepo("654015___7202", { files: SEED });
  const repo = repoFor("654015___7202");
  await repo.clone();
  await repo.commit("seed", AUTHOR, { parents: [await repo.sha("draft")] });
  await pushAndBuild(repo);
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

  await repo.compileDraft();
  await repo.publish();
});

test("an unclean build deletes the existing manifest, in the folder too, so the publish is refused MISSING", async () => {
  stub.addRepo("654015___7203", { files: SEED });
  const repo = repoFor("654015___7203");
  const entry = stub.repos.get("654015___7203");
  await repo.clone();
  await repo.commit("seed", AUTHOR, { parents: [await repo.sha("draft")] });
  await pushAndBuild(repo);
  assert.ok(fs.existsSync(path.join(repo.dir, ".build", ".b6p-build.json")));
  await repo.writeFile("scripts/app.ts", "export const broken = ;\n");
  await repo.commit("broken", AUTHOR);
  entry.buildUnclean = true;
  const build = await pushAndBuild(repo);
  assert.strictEqual(build.vouched, false);
  assert.strictEqual(build.fastForward.state, "fast-forwarded");
  assert.ok(!fs.existsSync(path.join(repo.dir, ".build", ".b6p-build.json")), "the deletion reached the folder");
  assert.ok(!(await repo.listTree("draft")).some((f) => f.path === ".build/.b6p-build.json"));
  assert.deepStrictEqual(await repo.status(), []);
  await rejects(repo.publish(), lib.PublishBuildManifestMissingError);
});

test("no tsconfig.json: nothing to build, no manifest, the publish is not checked; externally built: none either", async () => {
  stub.addRepo("654015___7204", { files: { "scripts/app.js": "exports.v = 1;\n" } });
  const plain = repoFor("654015___7204");
  await plain.clone();
  await plain.writeFile("scripts/app.js", "exports.v = 2;\n");
  await plain.commit("edit", AUTHOR);
  assert.strictEqual((await pushAndBuild(plain)).compile.status, "NOTHING_TO_COMPILE");
  assert.ok(!fs.existsSync(path.join(plain.dir, ".build", ".b6p-build.json")));
  await plain.publish();

  stub.addRepo("654015___7205", { files: SEED });
  stub.repos.get("654015___7205").externallyBuilt = true;
  const external = repoFor("654015___7205");
  await external.clone();
  await external.writeFile("scripts/app.ts", "export const v = 9;\n");
  await external.commit("bundled elsewhere", AUTHOR);
  assert.strictEqual((await pushAndBuild(external)).compile.status, "SKIPPED_EXTERNALLY_BUILT");
  assert.ok(!fs.existsSync(path.join(external.dir, ".build", ".b6p-build.json")));
  await external.publish();
});

test("a nested outDir follows §1/§2: the manifest sits in it and lists output outside it as a source", async () => {
  stub.addRepo("654015___7206", { files: { "tsconfig.json": tsconfig("./dist/"), "scripts/app.ts": "export {};\n" } });
  const dist = repoFor("654015___7206");
  await dist.clone();
  await dist.writeFile("client/.build/script.js", "client output\n");
  await dist.commit("client output", AUTHOR);
  await pushAndBuild(dist);
  assert.ok(fs.existsSync(path.join(dist.dir, "dist", "scripts", "app.js")));
  const m = JSON.parse(read(dist, "dist/.b6p-build.json"));
  assert.deepStrictEqual(Object.keys(m.sources), ["client/.build/script.js", "scripts/app.ts", "tsconfig.json"]);
  await dist.publish();
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

test("TypeScript sources: ts tsx mts cts in any case, never a declaration, never under the output folder", () => {
  const ts = (p, folder = ".build") => lib.isTypeScriptSource(p, folder);
  for (const p of ["a.ts", "a.tsx", "a.mts", "a.cts", "A.TS", "x/B.Tsx", "d.ts", "ad.ts", "a.dd.ts"]) {
    assert.strictEqual(ts(p), true, p);
  }
  for (const p of [
    "globals.d.ts",
    "env.d.mts",
    "x/types.D.TS",
    "a.d.cts",
    "a.js",
    "a.json",
    "a.mjs",
    ".build/a.ts",
    "README.md",
  ]) {
    assert.strictEqual(ts(p), false, p);
  }
  assert.strictEqual(ts("dist/a.ts", "dist"), false);
  assert.strictEqual(ts("scripts/a.ts", ""), true, "in-place output: a source beside its output");
  assert.strictEqual(lib.isBuildSource("globals.d.ts", ".build"), true, "a declaration is still a source");
});

test("a JS-only draft is exempt: no manifest, it publishes; one .ts makes the manifest required; a .d.ts-only draft is exempt; declarations stay in sources", async () => {
  stub.addRepo("654015___7301", { files: { "tsconfig.json": tsconfig(), "scripts/app.js": "exports.v = 1;\n" } });
  const repo = repoFor("654015___7301");
  await repo.clone();
  await repo.writeFile("scripts/app.js", "exports.v = 2;\n");
  await repo.commit("js edit", AUTHOR);
  await pushAndBuild(repo);
  assert.ok(
    !fs.existsSync(path.join(repo.dir, ".build", ".b6p-build.json")),
    "no manifest for a draft with no TypeScript"
  );
  await repo.publish();

  await repo.writeFile("scripts/new.ts", "export const n = 1;\n");
  await repo.commit("add one .ts, no build", AUTHOR);
  await repo.push();
  await rejects(repo.publish(), lib.PublishBuildManifestMissingError);
  await repo.compileDraft();
  assert.ok(fs.existsSync(path.join(repo.dir, ".build", ".b6p-build.json")));
  await repo.publish();

  stub.addRepo("654015___7302", {
    files: { "tsconfig.json": tsconfig(), "scripts/app.js": "x\n", "types/globals.d.ts": "declare const g: number;\n" },
  });
  const decl = repoFor("654015___7302");
  await decl.clone();
  await decl.writeFile("types/globals.d.ts", "declare const g: string;\n");
  await decl.commit("declaration only", AUTHOR);
  await pushAndBuild(decl);
  assert.ok(!fs.existsSync(path.join(decl.dir, ".build", ".b6p-build.json")), "a .d.ts alone is exempt");
  await decl.publish();

  await decl.writeFile("scripts/app.ts", "export {};\n");
  await decl.commit("a real ts", AUTHOR);
  await pushAndBuild(decl);
  const sources = Object.keys(JSON.parse(read(decl, ".build/.b6p-build.json")).sources);
  assert.deepStrictEqual(
    sources,
    ["scripts/app.js", "scripts/app.ts", "tsconfig.json", "types/globals.d.ts"],
    "the declaration is still listed"
  );
  await decl.publish();

  // A .ts only under the output folder does not count.
  stub.addRepo("654015___7303", {
    files: { "tsconfig.json": tsconfig(), ".build/gen.ts": "export {};\n", "a.js": "x\n" },
  });
  const inside = repoFor("654015___7303");
  await inside.clone();
  await inside.writeFile("a.js", "y\n");
  await inside.commit("edit", AUTHOR);
  await pushAndBuild(inside);
  assert.ok(!fs.existsSync(path.join(inside.dir, ".build", ".b6p-build.json")));
  await inside.publish();
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
