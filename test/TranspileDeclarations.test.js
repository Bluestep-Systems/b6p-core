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
// script (run via `npm test`). It exercises the COMPILED code against a real
// on-disk fixture: the static resolveDeclarationRootFiles (glob/existence via
// ts.sys) and the instance compileProject (the actual program build + emit).
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("node:assert");
const ts = require("typescript");
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

// ── Fixture-level: the merge actually resolves globals and does not change emit ──
//
// The helper tests above only cover resolveDeclarationRootFiles. These drive the
// real program build (ScriptTranspiler.compileProject) against an on-disk fixture,
// so reverting the "declarations first into rootFiles" merge turns the WITH-decls
// case red (platform global unresolved) instead of leaving the suite green.

const NOOP_LOGGER = { info() {}, warn() {}, debug() {}, error() {} };

function optionsFor(draftDir) {
  // The transpile invariants that matter for this assertion, set directly so the
  // test does not depend on the private applyTranspileInvariants.
  return {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    // Absolute so emit lands inside the fixture (a relative outDir resolves
    // against process.cwd(), i.e. the repo root, not the temp dir).
    outDir: path.join(draftDir, ".build"),
    rootDir: draftDir,
    listEmittedFiles: true,
    skipLibCheck: true,
    noEmitOnError: false,
  };
}

function messages(diagnostics) {
  return diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

test("WITH declarations: the platform global resolves and only app.js is emitted", () => {
  const fx = makeFixture(["../declarations/index.d.ts", "scripts/**/*.ts"]);
  try {
    const decls = ScriptTranspiler.resolveDeclarationRootFiles(fx.tsconfigPath, fx.config);
    const appTs = path.join(fx.draftDir, "scripts", "app.ts");
    const transpiler = new ScriptTranspiler({ logger: NOOP_LOGGER, typescriptLibDirs: undefined });
    const res = transpiler.compileProject(fx.tsconfigPath, [appTs], decls, optionsFor(fx.draftDir));

    assert.strictEqual(res.emitSkipped, false, "emit must not be skipped");
    assert.ok(
      !messages(res.diagnostics).some((m) => m.includes("Cannot find name 'B'")),
      "the platform global B must resolve once declarations are merged in"
    );
    const emitted = res.emittedFiles.map((f) => f.replace(/\\/g, "/"));
    assert.ok(
      emitted.some((f) => f.endsWith("/app.js")),
      `app.js must be emitted, got: ${emitted.join(", ")}`
    );
    assert.ok(
      !emitted.some((f) => f.endsWith(".d.ts") || f.includes("declarations/")),
      `declarations must emit nothing, got: ${emitted.join(", ")}`
    );
  } finally {
    rmrf(fx.root);
  }
});

test("WITHOUT declarations: the same program cannot resolve the platform global", () => {
  const fx = makeFixture(["../declarations/index.d.ts", "scripts/**/*.ts"]);
  try {
    const appTs = path.join(fx.draftDir, "scripts", "app.ts");
    const transpiler = new ScriptTranspiler({ logger: NOOP_LOGGER, typescriptLibDirs: undefined });
    const res = transpiler.compileProject(fx.tsconfigPath, [appTs], [], optionsFor(fx.draftDir));

    assert.ok(
      messages(res.diagnostics).some((m) => m.includes("Cannot find name 'B'")),
      "without the declaration, B must be unresolved — this is what the merge fixes"
    );
  } finally {
    rmrf(fx.root);
  }
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log("\nAll TranspileDeclarations tests passed.");
