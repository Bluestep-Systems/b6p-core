// Regression tests for the pre-publish type-check declarations gap
// (ClickUp 86bbeb659).
//
// THE BUG: `b6p push --snapshot` transpiled `scripts/app.ts` in isolation. The
// transpile builds its own root-file list by walking the `draft/` folder and
// parses the tsconfig with `readDirectory: () => []`, so the tsconfig's
// `include` — which points OUTSIDE `draft/` at the sibling
// `../declarations/index.d.ts` — was dropped. Every platform global (B,
// console, MEFR_*, the Bluestep namespace, …) then resolved to "Cannot find
// name", the JS was emitted anyway (noEmitOnError:false), and the push reported
// success having type-checked nothing but syntax.
//
// THE FIX: ScriptTranspiler.resolveDeclarationRootFiles() resolves the ambient
// `.d.ts` a tsconfig's include/files pull in, and transpile() adds them to the
// program's root files — the same effect as a hand-written
// `/// <reference path="../../declarations/index.d.ts" />`. Ambient `.d.ts`
// emit nothing, so this changes only what is type-checked, not what is emitted.
//
// b6p-core has no test framework; this is a minimal, dependency-free node
// script (run via `npm test`) that exercises the COMPILED static method against
// a real on-disk fixture (the method resolves globs and existence via ts.sys).
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("node:assert");
const { ScriptTranspiler } = require("../dist/script/ScriptTranspiler.js");

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log("ok   -", name);
  } catch (e) {
    failures++;
    console.error("FAIL -", name, "\n     ", e.message);
  }
}

// Build a throwaway component tree under a fresh temp dir:
//   <root>/declarations/index.d.ts
//   <root>/draft/tsconfig.json   (include drives resolution)
//   <root>/draft/scripts/app.ts
// Returns { root, draftDir, tsconfigPath, cleanup }.
function makeFixture(includeList) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "b6p-transpile-"));
  const declDir = path.join(root, "declarations");
  const draftDir = path.join(root, "draft");
  const scriptsDir = path.join(draftDir, "scripts");
  fs.mkdirSync(declDir, { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(path.join(declDir, "index.d.ts"), "declare const B: unknown;\n");
  fs.writeFileSync(path.join(scriptsDir, "app.ts"), "B;\n");
  const tsconfigPath = path.join(draftDir, "tsconfig.json");
  // The value passed to resolveDeclarationRootFiles is the PARSED tsconfig json.
  return { root, draftDir, tsconfigPath, config: { include: includeList, compilerOptions: {} } };
}

function rmrf(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

test("resolves the sibling ../declarations/index.d.ts named in include", () => {
  const fx = makeFixture(["../declarations/index.d.ts", "scripts/**/*.ts"]);
  try {
    const decls = ScriptTranspiler.resolveDeclarationRootFiles(fx.tsconfigPath, fx.config);
    assert.strictEqual(decls.length, 1, "exactly the one declaration file");
    assert.ok(
      decls[0].replace(/\\/g, "/").endsWith("/declarations/index.d.ts"),
      `expected the declarations file, got: ${decls[0]}`
    );
  } finally {
    rmrf(fx.root);
  }
});

test("returns only .d.ts, never the emitting scripts/*.ts sources", () => {
  const fx = makeFixture(["../declarations/index.d.ts", "scripts/**/*.ts"]);
  try {
    const decls = ScriptTranspiler.resolveDeclarationRootFiles(fx.tsconfigPath, fx.config);
    assert.ok(
      decls.every((f) => f.toLowerCase().endsWith(".d.ts")),
      `only .d.ts expected, got: ${decls.join(", ")}`
    );
    assert.ok(!decls.some((f) => f.endsWith("app.ts")), "app.ts must not be returned as a declaration");
  } finally {
    rmrf(fx.root);
  }
});

test("no declarations in include → empty (nothing to add)", () => {
  const fx = makeFixture(["scripts/**/*.ts"]);
  try {
    const decls = ScriptTranspiler.resolveDeclarationRootFiles(fx.tsconfigPath, fx.config);
    assert.deepStrictEqual(decls, []);
  } finally {
    rmrf(fx.root);
  }
});

test("a declaration listed but absent on disk is dropped (no phantom root file)", () => {
  const fx = makeFixture(["../declarations/missing.d.ts", "scripts/**/*.ts"]);
  try {
    const decls = ScriptTranspiler.resolveDeclarationRootFiles(fx.tsconfigPath, fx.config);
    assert.deepStrictEqual(decls, [], "a non-existent include entry must not be returned");
  } finally {
    rmrf(fx.root);
  }
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log("\nAll TranspileDeclarations tests passed.");
