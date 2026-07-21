// Regression tests for empty-outDir tolerance (b6p-cli#9, bug 2).
//
// THE BUG: a fresh `b6p pull` of a MergeReport with a `static/` bundle can
// leave `draft/static/tsconfig.json` with `"outDir": ""` (empty string). The
// next `b6p push` aborted in the pre-push build with a bare
// `MissingConfigurationError: outDir not specified`, because getBuildFolder()
// treated an empty string as "missing" and threw.
//
// THE FIX: TsConfig.resolveOutDir() normalizes an empty/whitespace/missing
// outDir to the transpiler's own default (`.build`) instead of throwing, so the
// build step tolerates it. `.build` (not `.`) is deliberate — it keeps a source
// `.ts` OUT of "its respective build folder" so it stays eligible for transpile.
//
// b6p-core has no test framework; this is a minimal, dependency-free node
// script (run via `npm test`) that exercises the COMPILED static method.
const assert = require("node:assert");
const { TsConfig } = require("../dist/script/TsConfig.js");
const { FolderNames } = require("../dist/constants/index.js");

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

const DEFAULT = FolderNames.DOT_BUILD; // ".build"

test("empty string outDir → default .build", () => {
  assert.strictEqual(TsConfig.resolveOutDir(""), DEFAULT);
});

test("whitespace-only outDir → default .build", () => {
  assert.strictEqual(TsConfig.resolveOutDir("   "), DEFAULT);
});

test("missing (undefined) outDir → default .build", () => {
  assert.strictEqual(TsConfig.resolveOutDir(undefined), DEFAULT);
});

test("null outDir → default .build", () => {
  assert.strictEqual(TsConfig.resolveOutDir(null), DEFAULT);
});

test("non-string outDir → default .build", () => {
  assert.strictEqual(TsConfig.resolveOutDir(42), DEFAULT);
});

test("a real outDir is preserved verbatim", () => {
  assert.strictEqual(TsConfig.resolveOutDir(".build"), ".build");
  assert.strictEqual(TsConfig.resolveOutDir("build"), "build");
  assert.strictEqual(TsConfig.resolveOutDir("."), ".");
  assert.strictEqual(TsConfig.resolveOutDir("dist/out"), "dist/out");
});

test("the default is never the empty string (would have re-broken push)", () => {
  assert.ok(DEFAULT.length > 0);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log("\nAll TsConfigBuildFolder tests passed.");
