// Regression tests for the stale-client-bundle push warning (b6p-cli#9, bug 1).
//
// THE BUG: `b6p push` does not transpile client TypeScript. A MergeReport
// `static/` bundle compiles `static/script.ts` into `static/.build/script.js`
// (its tsconfig `outDir`), and the platform serves that emitted JS verbatim —
// it does NOT recompile it server-side (verified against a live org). Editing
// only the `.ts` therefore silently ships stale client JS.
//
// THE FIX: ScriptRoot.selectStaleBundles() flags any client-bundle sub-project
// whose newest source `.ts`/`.tsx` is newer than the newest compiled `.js` in
// its build folder (or whose build folder has no JS while sources exist), and
// executePush() warns for each. Only NESTED tsconfigs are client bundles; the
// draft-root tsconfig governs platform-compiled `scripts/*.ts` and is excluded
// by the caller (findStaleClientBundles), so the pure core is only ever handed
// client-bundle sub-projects.
//
// b6p-core has no test framework; this is a minimal, dependency-free node
// script (run via `npm test`) that exercises the COMPILED static method.
const path = require("path");
const assert = require("node:assert");
const { ScriptRoot } = require("../dist/script/ScriptRoot.js");

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

const sep = path.sep;
const j = (...p) => p.join(sep);
const STATIC = j("U1", "Report", "draft", "static");
const STATIC_BUILD = j(STATIC, ".build");
// One bundle: the static/ sub-project emitting into static/.build.
const STATIC_BUNDLE = { sourceRoot: STATIC, buildFolder: STATIC_BUILD };

test("stale: static/script.ts is newer than static/.build/script.js", () => {
  const stale = ScriptRoot.selectStaleBundles({
    files: [
      { fsPath: j(STATIC, "script.ts"), mtime: 2000 },
      { fsPath: j(STATIC_BUILD, "script.js"), mtime: 1000 },
    ],
    bundles: [STATIC_BUNDLE],
  });
  assert.strictEqual(stale.length, 1);
  assert.strictEqual(stale[0].bundle, STATIC);
  assert.strictEqual(stale[0].buildFolder, STATIC_BUILD);
});

test("fresh: build JS newer than source → not stale", () => {
  const stale = ScriptRoot.selectStaleBundles({
    files: [
      { fsPath: j(STATIC, "script.ts"), mtime: 1000 },
      { fsPath: j(STATIC_BUILD, "script.js"), mtime: 2000 },
    ],
    bundles: [STATIC_BUNDLE],
  });
  assert.deepStrictEqual(stale, []);
});

test("equal mtimes → not stale (in sync)", () => {
  const stale = ScriptRoot.selectStaleBundles({
    files: [
      { fsPath: j(STATIC, "script.ts"), mtime: 1500 },
      { fsPath: j(STATIC_BUILD, "script.js"), mtime: 1500 },
    ],
    bundles: [STATIC_BUNDLE],
  });
  assert.deepStrictEqual(stale, []);
});

test("never compiled: sources exist, build folder has no JS → stale", () => {
  const stale = ScriptRoot.selectStaleBundles({
    files: [{ fsPath: j(STATIC, "script.ts"), mtime: 1000 }],
    bundles: [STATIC_BUNDLE],
  });
  assert.strictEqual(stale.length, 1);
  assert.strictEqual(stale[0].bundle, STATIC);
});

test("empty bundle: no sources at all → not stale", () => {
  const stale = ScriptRoot.selectStaleBundles({
    files: [{ fsPath: j(STATIC_BUILD, "script.js"), mtime: 1000 }],
    bundles: [STATIC_BUNDLE],
  });
  assert.deepStrictEqual(stale, []);
});

test("the compiled .js in .build is NOT itself counted as a source", () => {
  // Regression: .build/script.js lives under sourceRoot too; it must be treated
  // as build output, never as a newer 'source' that flags itself.
  const stale = ScriptRoot.selectStaleBundles({
    files: [
      { fsPath: j(STATIC, "script.ts"), mtime: 1000 },
      { fsPath: j(STATIC_BUILD, "script.js"), mtime: 5000 },
    ],
    bundles: [STATIC_BUNDLE],
  });
  assert.deepStrictEqual(stale, []);
});

test(".d.ts declarations are not sources", () => {
  const stale = ScriptRoot.selectStaleBundles({
    files: [
      { fsPath: j(STATIC, "types.d.ts"), mtime: 9000 },
      { fsPath: j(STATIC_BUILD, "script.js"), mtime: 1000 },
      { fsPath: j(STATIC, "script.ts"), mtime: 500 },
    ],
    bundles: [STATIC_BUNDLE],
  });
  // Only the .d.ts is newer than build; the real source (script.ts) is older.
  assert.deepStrictEqual(stale, []);
});

test("newest source wins: a .tsx in a subdir newer than build → stale", () => {
  const stale = ScriptRoot.selectStaleBundles({
    files: [
      { fsPath: j(STATIC, "script.ts"), mtime: 500 },
      { fsPath: j(STATIC, "components", "widget.tsx"), mtime: 3000 },
      { fsPath: j(STATIC_BUILD, "script.js"), mtime: 1000 },
    ],
    bundles: [STATIC_BUNDLE],
  });
  assert.strictEqual(stale.length, 1);
  assert.strictEqual(stale[0].bundle, STATIC);
});

test("multiple bundles assessed independently", () => {
  const A = j("U1", "Report", "draft", "widgetA");
  const B = j("U1", "Report", "draft", "widgetB");
  const stale = ScriptRoot.selectStaleBundles({
    files: [
      { fsPath: j(A, "x.ts"), mtime: 2000 },
      { fsPath: j(A, ".build", "x.js"), mtime: 1000 }, // A stale
      { fsPath: j(B, "y.ts"), mtime: 1000 },
      { fsPath: j(B, ".build", "y.js"), mtime: 2000 }, // B fresh
    ],
    bundles: [
      { sourceRoot: A, buildFolder: j(A, ".build") },
      { sourceRoot: B, buildFolder: j(B, ".build") },
    ],
  });
  assert.strictEqual(stale.length, 1);
  assert.strictEqual(stale[0].bundle, A);
});

test("no bundles → no warnings (e.g. a component with only the root tsconfig)", () => {
  const stale = ScriptRoot.selectStaleBundles({
    files: [{ fsPath: j("U1", "Report", "draft", "scripts", "app.ts"), mtime: 9999 }],
    bundles: [],
  });
  assert.deepStrictEqual(stale, []);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log("\nAll StaleClientBundles tests passed.");
