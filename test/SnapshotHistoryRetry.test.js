// Regression tests for snapshot-history recording (ClickUp 86bbed9wu) — the
// SECOND consecutive snapshot push to the same component uploaded and compiled
// but failed to record its history entry with a server-side optimistic-locking
// error ("Unable to update BaseTable because of version mismatch: expected
// ver. N, actual ver. N+1"), while the push still printed "Snapshot complete!".
//
// The client sends no version anywhere — the mismatch is the platform still
// settling the version bump from the upload that just finished. Waiting fixes
// it (running `b6p audit` between pushes "worked" purely as a delay), so
// SnapshotHistoryRecorder.record() now retries the mutation with backoff when —
// and only when — the GraphQL error is a version mismatch. Everything else
// still fails on the first attempt. The dishonest completion message is fixed
// separately in push.ts.
//
// b6p-core has no test framework; this is a minimal, dependency-free node
// script (run via `npm test`). It exercises the COMPILED classes from dist/
// with a fake ScriptRoot so no network or real filesystem is touched.
const assert = require("node:assert");
const { SnapshotHistoryRecorder } = require("../dist/script/SnapshotHistoryRecorder.js");
const { ScriptKey } = require("../dist/data/ScriptKey.js");

let failures = 0;
const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// Injected per-call so the retry path runs instantly under test — record()'s
// default schedule is a private readonly constant, deliberately not mutable
// shared state.
const TEST_OPTS = { retryDelaysMs: [0, 0, 0] };
const MAX_ATTEMPTS = TEST_OPTS.retryDelaysMs.length + 1;

const VERSION_MISMATCH = "Unable to update BaseTable because of version mismatch: expected ver. 5, actual ver. 6";

/**
 * Build a fake ScriptRoot whose sessionManager.csrfFetch answers from `bodies`
 * in order (each entry is the parsed JSON the GraphQL endpoint returns).
 */
function makeScriptRoot(bodies) {
  const calls = [];
  const noop = () => {};
  const ctx = {
    logger: { debug: noop, info: noop, warn: noop, error: noop },
    fs: { readFile: async () => new Uint8Array() },
    sessionManager: {
      csrfFetch: async (_url, init) => {
        calls.push(init);
        const body = bodies[Math.min(calls.length - 1, bodies.length - 1)];
        if (body.__httpStatus) {
          return new Response(body.__text ?? "server error", { status: body.__httpStatus });
        }
        return new Response(JSON.stringify(body), { status: 200 });
      },
    },
  };
  const draftFolder = {
    flatten: async () => [],
    uri: () => ({ fsPath: "/ws/U100001/MyScript/draft" }),
  };
  const scriptRoot = {
    ctx,
    getScriptKey: async () => new ScriptKey("654015", "42"), // formula → updateScriptFormula
    getDraftFolder: () => draftFolder,
    anyOrigin: async () => "https://org.bluestep.net/",
  };
  return { scriptRoot, calls };
}

test("version mismatch then success → retried, resolves after 2 attempts", async () => {
  const { scriptRoot, calls } = makeScriptRoot([
    { errors: [{ message: VERSION_MISMATCH }] },
    { data: { updateScriptFormula: [{ id: "654015___42" }] } },
  ]);
  await SnapshotHistoryRecorder.record(scriptRoot, "second snapshot", TEST_OPTS);
  assert.strictEqual(calls.length, 2);
});

test("reworded mismatch (version clause only) → still retried", async () => {
  const { scriptRoot, calls } = makeScriptRoot([
    { errors: [{ message: "Unable to update BaseTable: expected ver. 5, actual ver. 6" }] },
    { data: { updateScriptFormula: [{ id: "654015___42" }] } },
  ]);
  await SnapshotHistoryRecorder.record(scriptRoot, "msg", TEST_OPTS);
  assert.strictEqual(calls.length, 2);
});

test("persistent version mismatch → throws after exhausting every attempt", async () => {
  const { scriptRoot, calls } = makeScriptRoot([{ errors: [{ message: VERSION_MISMATCH }] }]);
  await assert.rejects(
    () => SnapshotHistoryRecorder.record(scriptRoot, "msg", TEST_OPTS),
    (e) => /version mismatch/i.test(e.message)
  );
  assert.strictEqual(calls.length, MAX_ATTEMPTS);
});

test("non-2xx HTTP response → no retry, throws on the first attempt", async () => {
  // The one branch where a wrong call would multiply retries against a server
  // that is actually down.
  const { scriptRoot, calls } = makeScriptRoot([{ __httpStatus: 500, __text: "boom" }]);
  await assert.rejects(
    () => SnapshotHistoryRecorder.record(scriptRoot, "msg", TEST_OPTS),
    (e) => /500/.test(e.message)
  );
  assert.strictEqual(calls.length, 1);
});

test("unrelated error containing 'version mismatch' phrase → NOT retried", async () => {
  // The predicate is anchored on the optimistic-lock wording; a fatal
  // schema/client complaint must fail fast instead of burning the backoff.
  const { scriptRoot, calls } = makeScriptRoot([{ errors: [{ message: "Schema version mismatch: client too old" }] }]);
  await assert.rejects(
    () => SnapshotHistoryRecorder.record(scriptRoot, "msg", TEST_OPTS),
    (e) => /client too old/.test(e.message)
  );
  assert.strictEqual(calls.length, 1);
});

test("non-mismatch GraphQL error → no retry, throws on the first attempt", async () => {
  const { scriptRoot, calls } = makeScriptRoot([{ errors: [{ message: "Access denied" }] }]);
  await assert.rejects(
    () => SnapshotHistoryRecorder.record(scriptRoot, "msg", TEST_OPTS),
    (e) => /Access denied/.test(e.message)
  );
  assert.strictEqual(calls.length, 1);
});

test("clean success → single attempt", async () => {
  const { scriptRoot, calls } = makeScriptRoot([{ data: { updateScriptFormula: [{ id: "654015___42" }] } }]);
  await SnapshotHistoryRecorder.record(scriptRoot, "", TEST_OPTS);
  assert.strictEqual(calls.length, 1);
});

test("unknown classid → skips recording without any network call", async () => {
  const { scriptRoot, calls } = makeScriptRoot([]);
  scriptRoot.getScriptKey = async () => new ScriptKey("999999", "1");
  await SnapshotHistoryRecorder.record(scriptRoot, "msg", TEST_OPTS);
  assert.strictEqual(calls.length, 0);
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
  console.log("\nAll SnapshotHistoryRetry tests passed.");
})();
