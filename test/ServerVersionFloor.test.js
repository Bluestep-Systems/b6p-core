// Server version floor and route choice (rulings 42-44, ClickUp 86bczwj62): a push first asks the org's
// server for its version. `dev` or >= MIN_SERVER_VERSION gets the server compile (compileDraft /
// takeSnapshot); below it, an unreadable version, or the floor unset gets the local TS 7.1 fallback.
// Nothing is refused any more. One constant, MIN_SERVER_VERSION, unset until the first web tag
// containing the server flow exists. Covers the pure comparator and resolveCompileRoute; the route
// through executePush is in LocalFallbackPush.test.js.
// Dependency-free; runs the COMPILED classes from dist/ with no network or real filesystem.

const assert = require("node:assert");
const { Err } = require("../dist/Err.js");
const {
  parseReleaseTag,
  meetsMinimumVersion,
  resolveCompileRoute,
  MIN_SERVER_VERSION,
} = require("../dist/data/ServerVersion.js");

let failures = 0;
const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const FLOOR = "26.11.09.00"; // a stand-in floor injected into the route; the real one is unset

// ── Comparator ──
test("equal version meets the floor", () => assert.strictEqual(meetsMinimumVersion(FLOOR, FLOOR), true));
test("older day is below", () => assert.strictEqual(meetsMinimumVersion("26.11.02.00", FLOOR), false));
test("older patch on a backport line is below", () => {
  assert.strictEqual(meetsMinimumVersion("26.11.02.05", FLOOR), false);
  assert.strictEqual(meetsMinimumVersion("26.11.09.00", "26.11.09.01"), false);
});
test("newer meets the floor, numerically not lexically", () => {
  assert.strictEqual(meetsMinimumVersion("26.11.16.00", FLOOR), true);
  assert.strictEqual(meetsMinimumVersion("26.12.01.00", FLOOR), true);
  assert.strictEqual(meetsMinimumVersion("27.01.01.00", FLOOR), true);
  assert.strictEqual(meetsMinimumVersion("26.11.09.10", "26.11.09.02"), true);
});
test("dev is current", () => assert.strictEqual(meetsMinimumVersion("dev", FLOOR), true));
test("empty and garbage do not meet", () => {
  for (const v of ["", "   ", "garbage", "26.11.09", "26.11.09.00.1", "DEV", "v26.11.09.00", "<html>404</html>"]) {
    assert.strictEqual(meetsMinimumVersion(v, FLOOR), false, v);
  }
});
test("whitespace around a tag is ignored", () => {
  assert.deepStrictEqual(parseReleaseTag(" 26.11.09.00\n"), [26, 11, 9, 0]);
  assert.strictEqual(meetsMinimumVersion("26.11.09.00\n", FLOOR), true);
  assert.strictEqual(parseReleaseTag("nope"), null);
});
test("the one real floor is unset until the first web tag with #1961 and #1957 is cut", () => {
  assert.strictEqual(MIN_SERVER_VERSION, null);
});

// ── Route ──
function fetcher(answer) {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    if (answer instanceof Error) {
      throw answer;
    }
    return new Response(answer.body ?? "", { status: answer.status ?? 200 });
  };
  return { fn, calls };
}

async function route(answer, floor = FLOOR) {
  const f = fetcher(answer);
  const r = await resolveCompileRoute({ origin: "https://org.bluestep.net/files/1/draft", fetchFn: f.fn, floor });
  return { ...r, calls: f.calls };
}

test("asks /appinfo/version on the origin", async () => {
  const r = await route({ body: FLOOR });
  assert.deepStrictEqual(r.calls, ["https://org.bluestep.net/appinfo/version"]);
});
test("at or above the floor → server", async () => {
  for (const body of [FLOOR, "26.11.16.00\n"]) {
    const r = await route({ body });
    assert.strictEqual(r.mode, "server", body);
    assert.strictEqual(r.reason, "at-or-above-floor");
    assert.strictEqual(r.serverVersion, body.trim());
    assert.strictEqual(r.required, FLOOR);
  }
});
test("dev → server, even with the floor unset", async () => {
  for (const floor of [FLOOR, null]) {
    const r = await route({ body: "dev" }, floor);
    assert.deepStrictEqual([r.mode, r.reason, r.serverVersion], ["server", "dev", "dev"]);
  }
});
test("below the floor (a backport patch included) → local, with both versions", async () => {
  const r = await route({ body: "26.11.02.05\n" });
  assert.deepStrictEqual([r.mode, r.reason, r.serverVersion, r.required], ["local", "below-floor", "26.11.02.05", FLOOR]);
});
test("404, 500, empty body, garbage and network failure → local, reason unknown", async () => {
  for (const [answer, seen] of [
    [{ status: 404, body: "no" }, null],
    [{ status: 500 }, null],
    [{ body: "  " }, null],
    [{ body: "banana" }, "banana"],
    [new Error("ECONNRESET"), null],
  ]) {
    const r = await route(answer);
    assert.deepStrictEqual([r.mode, r.reason, r.serverVersion], ["local", "unknown", seen]);
  }
});
test("floor unset → a release tag goes local (floor-unset); an unreadable one is still unknown", async () => {
  const r = await route({ body: "30.01.01.00" }, null);
  assert.deepStrictEqual([r.mode, r.reason, r.required], ["local", "floor-unset", null]);
  assert.strictEqual((await route({ status: 404 }, null)).reason, "unknown");
});
test("the real default floor is the unset one: a release tag goes local, dev to the server", async () => {
  const f = fetcher({ body: "30.01.01.00" });
  const r = await resolveCompileRoute({ origin: "https://org.bluestep.net", fetchFn: f.fn });
  assert.strictEqual(r.reason, "floor-unset");
  const d = fetcher({ body: "dev" });
  assert.strictEqual((await resolveCompileRoute({ origin: "https://org.bluestep.net", fetchFn: d.fn })).mode, "server");
});
test("a push is no longer refused for its server version: the old error is gone", () => {
  assert.strictEqual(Err.ServerVersionUnsupportedError, undefined);
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (e) {
      failures++;
      console.error(`not ok - ${name}\n  ${e && e.stack ? e.stack : e}`);
    }
  }
  if (failures > 0) {
    console.error(`${failures} failed`);
    process.exit(1);
  }
  console.log(`${tests.length} passed`);
})();
