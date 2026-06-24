// Regression tests for DownstairsPathParser — focused on the Windows drive-letter
// path bug (a bogus separator was prepended before the drive, e.g. "\C:\..." ).
//
// b6p-core has no test framework; this is a minimal, dependency-free node script
// (run via `npm test`). It exercises the COMPILED class from dist/.
//
// Why the win32 override: the parser binds to the ambient `path` module, which is
// POSIX on Linux/macOS CI runners — so a raw "C:\..." input would be parsed as a
// relative path and never hit the Windows branch. `path.win32` IS Node's real
// Windows path implementation, so swapping `path`'s members for their win32
// equivalents faithfully exercises the Windows code path on any host (including
// b6p-core's ubuntu-only CI matrix). POSIX behavior is asserted with the real
// (un-overridden) path module to guard against regressions.
const path = require("path");
const assert = require("node:assert");
const { DownstairsPathParser } = require("../dist/data/DownstairsPathParser.js");

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

// Run `fn` with the ambient `path` module's members swapped for path.win32,
// then restore them — so POSIX tests outside this block are unaffected.
function withWin32(fn) {
  const keys = ["sep", "parse", "join", "isAbsolute", "relative", "dirname", "basename", "normalize"];
  const saved = {};
  for (const k of keys) {
    saved[k] = path[k];
  }
  try {
    for (const k of keys) {
      Object.defineProperty(path, k, { value: path.win32[k], configurable: true, writable: true });
    }
    fn();
  } finally {
    for (const k of keys) {
      Object.defineProperty(path, k, { value: saved[k], configurable: true, writable: true });
    }
  }
}

// --- POSIX (real ambient path) — guard against regressions in the existing behavior ---
test("POSIX: absolute draft path keeps its root, no mangling", () => {
  const p = new DownstairsPathParser("/some/path/U123456/MyScript/draft/file.js");
  assert.strictEqual(p.prependingPath, "/some/path/U123456");
  assert.strictEqual(p.getShavedName(), "/some/path/U123456/MyScript");
  assert.strictEqual(p.U, "U123456");
  assert.strictEqual(p.scriptName, "MyScript");
  assert.strictEqual(p.type, "draft");
  assert.strictEqual(p.rest, "file.js");
});

// --- Windows (path.win32 semantics) — the actual fix ---
withWin32(() => {
  test("Windows: drive-letter draft path is un-mangled", () => {
    const p = new DownstairsPathParser("C:\\Users\\jdoe\\ws\\U100001\\MyScript\\draft\\file.js");
    // The bug produced "\\C:\\Users\\jdoe\\ws\\U100001" (bogus leading separator before "C:").
    assert.strictEqual(p.prependingPath, "C:\\Users\\jdoe\\ws\\U100001");
    assert.ok(!p.prependingPath.startsWith("\\"), "prependingPath must not start with a separator before the drive");
    assert.strictEqual(p.getShavedName(), "C:\\Users\\jdoe\\ws\\U100001\\MyScript");
    assert.strictEqual(p.U, "U100001");
    assert.strictEqual(p.scriptName, "MyScript");
    assert.strictEqual(p.type, "draft");
    assert.strictEqual(p.rest, "file.js");
  });

  test("Windows: drive-letter root path (no type segment) keeps the drive", () => {
    const p = new DownstairsPathParser("C:\\Users\\jdoe\\ws\\U100001\\MyScript");
    assert.strictEqual(p.prependingPath, "C:\\Users\\jdoe\\ws\\U100001");
    assert.strictEqual(p.getShavedName(), "C:\\Users\\jdoe\\ws\\U100001\\MyScript");
    assert.strictEqual(p.type, "root");
    assert.strictEqual(p.scriptName, "MyScript");
    assert.strictEqual(p.rest, "");
  });
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log("\nAll DownstairsPathParser tests passed.");
