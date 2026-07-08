// Regression tests for issue #4 — `audit` always reported declaration files as
// changed, even right after a clean pull.
//
// THE BUG: audit compares each file's local SHA-512 (ScriptFile.getHash) against
// the server ETag (ScriptFile.getUpstairsHash). Declaration/library files are
// served with numeric or complex ("memory document") ETags, not SHA-512 content
// hashes, so getUpstairsHash returns null for them. The old currentIntegrityMatches
// evaluated `localHash === null`, which is always false, so those files were
// reported changed on EVERY audit — a permanent false positive. (download() already
// skips integrity verification for those same ETag classes, which is why the pull
// itself succeeds.)
//
// THE FIX: currentIntegrityStatus() distinguishes "indeterminate" (no comparable
// upstairs hash) from a genuine "mismatch". Audit only reports "mismatch".
//
// b6p-core has no test framework; this is a minimal, dependency-free node script
// (run via `npm test`). It exercises the COMPILED classes from dist/ with a fake
// ScriptContext so no network or real filesystem is touched.
const path = require("path");
const crypto = require("crypto");
const assert = require("node:assert");
const { ScriptFile } = require("../dist/script/ScriptFile.js");
const { B6PUri } = require("../dist/B6PUri.js");

let failures = 0;
const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// An absolute, parseable script-file path on any host (POSIX or Windows): the
// DownstairsPathParser only requires a `U######` segment followed by a scriptName
// and a known type folder.
const FILE_PATH = path.join(path.parse(process.cwd()).root, "ws", "U100001", "MyScript", "declarations", "index.d.ts");

// Build a ScriptFile backed by a fake ScriptContext: stubbed fs (returns the given
// local content) and a stubbed sessionManager whose HEAD response carries `etagValue`
// (pass null to omit the ETag header entirely).
function makeFile(localContent, etagValue) {
  const bytes = Buffer.from(localContent, "utf8");
  const noop = () => {};
  const logger = { debug: noop, info: noop, warn: noop, error: noop };
  const fs = {
    stat: async () => ({ type: "file", mtime: 0, ctime: 0, size: bytes.length }),
    readFile: async () => new Uint8Array(bytes),
  };
  const sessionManager = {
    fetch: async () => new Response(null, { status: 200, headers: etagValue === null ? {} : { etag: etagValue } }),
  };
  const ctx = { fs, sessionManager, logger, isDebugMode: () => false };
  // Minimal ScriptRoot stand-in: ScriptNode reads `.ctx` (and `.factory`, unused here).
  const scriptRoot = { ctx, factory: {} };
  return new ScriptFile(B6PUri.fromFsPath(FILE_PATH), scriptRoot);
}

// Audit always passes an upstairsOverride, which short-circuits getUpstairsHash's URL
// resolution — mirror that so the check exercises only the ETag/hash comparison.
const OPS = { upstairsOverride: new URL("https://org.bluestep.net/files/100001/declarations/index.d.ts") };

const CONTENT = "declare const x: number;\n";
// Quoted SHA-512 of CONTENT — the ETag shape the server sends for real WebDAV files.
const matchingEtag = '"' + crypto.createHash("sha512").update(Buffer.from(CONTENT, "utf8")).digest("hex") + '"';
// A different, well-formed 128-hex ETag — a genuine content difference.
const differingEtag = '"' + "a".repeat(128) + '"';
// Numeric + complex ETags: how declaration/library "memory documents" are served.
const numericEtag = '"1700000000000-123_456"';
const complexEtag =
  '"1700000000000-{"class": "myassn.document.LibraryServletMemoryDocumentKey", "classId": 42}"';

// ─── currentIntegrityStatus: the tri-state at the heart of the fix ───────────

test("status: equal SHA-512 hashes → match", async () => {
  const file = makeFile(CONTENT, matchingEtag);
  assert.strictEqual(await file.currentIntegrityStatus(OPS), "match");
});

test("status: differing SHA-512 hashes → mismatch", async () => {
  const file = makeFile(CONTENT, differingEtag);
  assert.strictEqual(await file.currentIntegrityStatus(OPS), "mismatch");
});

test("status: numeric ETag (no content hash) → indeterminate, NOT mismatch", async () => {
  const file = makeFile(CONTENT, numericEtag);
  assert.strictEqual(await file.currentIntegrityStatus(OPS), "indeterminate");
});

test("status: complex memory-document ETag → indeterminate (the issue #4 case)", async () => {
  const file = makeFile(CONTENT, complexEtag);
  assert.strictEqual(await file.currentIntegrityStatus(OPS), "indeterminate");
});

test("status: missing ETag header → indeterminate", async () => {
  const file = makeFile(CONTENT, null);
  assert.strictEqual(await file.currentIntegrityStatus(OPS), "indeterminate");
});

// ─── currentIntegrityMatches: push behavior must be byte-for-byte unchanged ──
// (indeterminate and mismatch both return false, exactly as before the fix.)

test("matches: match → true", async () => {
  assert.strictEqual(await makeFile(CONTENT, matchingEtag).currentIntegrityMatches(OPS), true);
});

test("matches: mismatch → false", async () => {
  assert.strictEqual(await makeFile(CONTENT, differingEtag).currentIntegrityMatches(OPS), false);
});

test("matches: indeterminate → false (unchanged push semantics)", async () => {
  assert.strictEqual(await makeFile(CONTENT, numericEtag).currentIntegrityMatches(OPS), false);
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log("ok   -", name);
    } catch (e) {
      failures++;
      console.error("FAIL -", name, "\n     ", e.message);
    }
  }
  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll AuditIntegrity tests passed.");
})();
