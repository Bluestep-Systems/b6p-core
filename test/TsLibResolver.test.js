// Regression tests for the bundled-TypeScript lib-resolution fix.
//
// THE BUG: b6p-core is bundled by its consumers into a single file (the CLI's
// dist/cli.js and its SEA binary). TypeScript's default CompilerHost locates its
// standard library via getDefaultLibLocation() = dirname(__filename). Once
// bundled, __filename is the bundle path — so TS looks for lib.*.d.ts next to the
// bundle, where they never exist, and every compile fails with "Cannot find
// global type 'Array'" / "lib.*.d.ts not found".
//
// THE FIX: TsLibResolver locates the real lib directory WITHOUT relying on
// __filename, and ScriptTranspiler overrides the host's getDefaultLibLocation /
// getDefaultLibFileName with it.
//
// b6p-core has no test framework; this is a minimal, dependency-free node script
// (run via `npm test`). It exercises the COMPILED class from dist/ and uses the
// repo's own `typescript` install as a real lib directory to resolve against.
const path = require("path");
const fs = require("fs");
const os = require("os");
const assert = require("node:assert");
const ts = require("typescript");
const { TsLibResolver } = require("../dist/script/TsLibResolver.js");

// The repo's real TypeScript lib directory (…/node_modules/typescript/lib).
// require.resolve("typescript") → …/lib/typescript.js, so its dirname is the lib dir.
const TS_LIB_DIR = path.dirname(require.resolve("typescript"));
const REPO_ROOT = path.resolve(__dirname, "..");
// Stands in for "the directory next to the bundle": a real directory that does
// NOT contain lib.*.d.ts. This is exactly what dirname(__filename) points at once
// b6p-core is bundled.
const BUNDLE_DIR = path.join(REPO_ROOT, "dist");

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

// ─── TsLibResolver.resolveLibDir ────────────────────────────────────────────

test("resolveLibDir: returns an explicit dir that contains lib.d.ts", () => {
  const dir = TsLibResolver.resolveLibDir({ explicitDirs: [TS_LIB_DIR] });
  assert.strictEqual(dir, TS_LIB_DIR);
});

test("resolveLibDir: explicit dirs take precedence over the node_modules walk", () => {
  // A real lib dir passed explicitly must win even though the project walk would
  // also find one — this is the CLI-supplied (npm-bundle/SEA) path.
  const dir = TsLibResolver.resolveLibDir({
    explicitDirs: [TS_LIB_DIR],
    projectDirs: [path.join(REPO_ROOT, "src", "script")],
  });
  assert.strictEqual(dir, TS_LIB_DIR);
});

test("resolveLibDir: skips a bogus explicit dir and walks up projectDirs to node_modules", () => {
  const dir = TsLibResolver.resolveLibDir({
    explicitDirs: [BUNDLE_DIR], // no lib files here — must be skipped
    projectDirs: [path.join(REPO_ROOT, "src", "script")], // walks up to node_modules/typescript/lib
  });
  assert.ok(dir, "should resolve a lib dir by walking up to node_modules/typescript/lib");
  assert.ok(fs.existsSync(path.join(dir, "lib.d.ts")), "resolved dir must actually contain lib.d.ts");
});

test("resolveLibDir: returns undefined when nothing contains lib files", () => {
  // A fresh temp dir with no typescript install anywhere up its tree, and only a
  // bogus explicit dir. The resolver must give up (so the caller falls back to
  // default host behavior) rather than return a bogus path.
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "b6p-nolib-"));
  try {
    const dir = TsLibResolver.resolveLibDir({ explicitDirs: [BUNDLE_DIR], projectDirs: [emptyDir] });
    assert.strictEqual(dir, undefined);
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});

test("resolveLibDir: returns undefined when given nothing", () => {
  assert.strictEqual(TsLibResolver.resolveLibDir({}), undefined);
});

// ─── The bug + the fix, end-to-end at the TypeScript level ───────────────────
//
// compileSnippet builds a ts.Program for a snippet that leans on the standard
// library (Array, Promise, String), with the host's default-lib resolution
// pointed at `libDir`. This is precisely the knob the fix turns: the ONLY
// difference between the broken and fixed programs is which directory the host
// resolves libs from.

const SNIPPET = [
  "const xs: number[] = [1, 2, 3];",
  "const doubled = xs.map((n) => n * 2);",
  "const p: Promise<number> = Promise.resolve(doubled.length);",
  "const joined: string = ['a', 'b'].join('-');",
  "void p; void joined;",
].join("\n");

function compileSnippet(libDir) {
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    noEmit: true,
    types: [], // don't pull @types/node etc. — keep this strictly about the default lib
    skipLibCheck: true,
  };
  const host = ts.createCompilerHost(options);
  const virtual = path.join(REPO_ROOT, "__tslibresolver_virtual__.ts");

  // Mirror the fix: override BOTH host methods. (TS's default getDefaultLibFileName
  // closure captures an internal location fn, not host.getDefaultLibLocation, so
  // overriding only one would silently not work — pointing both here reproduces
  // whichever directory we hand in.)
  host.getDefaultLibLocation = () => libDir;
  host.getDefaultLibFileName = (o) => path.join(libDir, ts.getDefaultLibFileName(o));

  // Serve the snippet in-memory so we don't touch disk for the source file.
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (path.resolve(fileName) === virtual) {
      return ts.createSourceFile(fileName, SNIPPET, languageVersion, true);
    }
    return originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };

  const program = ts.createProgram([virtual], options, host);
  return ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

test("BUG: host pointed at the bundle dir (no lib.*.d.ts) cannot find the standard library", () => {
  const diags = compileSnippet(BUNDLE_DIR);
  assert.ok(diags.length > 0, "expected lib-resolution diagnostics when libs are not next to the bundle");
  assert.ok(
    diags.some((m) => /Cannot find (global type|name)/.test(m) || /lib\..*\.d\.ts/.test(m)),
    "expected 'Cannot find global type/name' or a missing lib.*.d.ts error, got:\n  " + diags.join("\n  ")
  );
});

test("FIX: host pointed at the resolved lib dir compiles with zero diagnostics", () => {
  const libDir = TsLibResolver.resolveLibDir({ projectDirs: [REPO_ROOT] });
  assert.ok(libDir, "resolver must locate the repo's typescript lib dir");
  const diags = compileSnippet(libDir);
  assert.deepStrictEqual(diags, [], "expected no diagnostics once the lib dir is resolved, got:\n  " + diags.join("\n  "));
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log("\nAll TsLibResolver tests passed.");
