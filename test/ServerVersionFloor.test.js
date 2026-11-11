// Server version floor and route (rulings 42-43 and 46, ClickUp 86bczwj62): core no longer compiles, so a
// push first confirms the org's server runs the compileDraft/takeSnapshot flow. One constant,
// MIN_SERVER_VERSION, 26.11.09.00 (the first web tag containing #1961 and #1957). A server below it (or an
// unreadable version, or the floor unset) is not refused: it gets the draft-only route. Covers the pure
// comparator, resolvePushRoute and snapshotRefusalFor; the end-to-end routing is PushRouting.test.js.
// Dependency-free; runs the COMPILED classes from dist/ with no network or real filesystem.

const assert = require("node:assert");
const {
  parseReleaseTag,
  meetsMinimumVersion,
  resolvePushRoute,
  snapshotRefusalFor,
  MIN_SERVER_VERSION,
} = require("../dist/data/ServerVersion.js");

let failures = 0;
const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const FLOOR = "26.11.09.00"; // a stand-in floor injected into the gate; the real one is unset

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
test("latest is current (web's fast local build, ruling 49)", () =>
  assert.strictEqual(meetsMinimumVersion("latest", FLOOR), true));
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
test("the one real floor is the first web tag with #1961 and #1957", () => {
  assert.strictEqual(MIN_SERVER_VERSION, "26.11.09.00");
});

// ── Gate ──
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
  const r = await resolvePushRoute({ origin: "https://org.bluestep.net/files/1/draft", fetchFn: f.fn, floor });
  return { route: r, calls: f.calls };
}
const draftOnly = (reason, serverVersion, required = FLOOR) => ({
  mode: "draft-only",
  reason,
  serverVersion,
  required,
});

test("asks /appinfo/version on the origin", async () => {
  const r = await route({ body: FLOOR });
  assert.deepStrictEqual(r.calls, ["https://org.bluestep.net/appinfo/version"]);
  assert.deepStrictEqual(r.route, {
    mode: "server",
    reason: "at-or-above-floor",
    serverVersion: FLOOR,
    required: FLOOR,
  });
});
test("below the floor is draft-only with both versions, never an error", async () => {
  const r = await route({ body: "26.11.02.05\n" });
  assert.deepStrictEqual(r.route, draftOnly("below-floor", "26.11.02.05"));
  assert.deepStrictEqual(snapshotRefusalFor(r.route), {
    reason: "too-old",
    serverVersion: "26.11.02.05",
    required: FLOOR,
  });
});
test("current and dev take the server route, which refuses no snapshot", async () => {
  const cur = await route({ body: "26.11.16.00" });
  assert.strictEqual(cur.route.mode, "server");
  assert.strictEqual(snapshotRefusalFor(cur.route), null);
  const dev = await route({ body: "dev" });
  assert.deepStrictEqual(dev.route, { mode: "server", reason: "dev", serverVersion: "dev", required: FLOOR });
  assert.strictEqual(snapshotRefusalFor(dev.route), null);
  const latest = await route({ body: "latest" });
  assert.deepStrictEqual(latest.route, { mode: "server", reason: "dev", serverVersion: "latest", required: FLOOR });
  assert.strictEqual(snapshotRefusalFor(latest.route), null);
});
test("404, 500, empty body, garbage and network failure are draft-only, unknown", async () => {
  for (const [answer, seen] of [
    [{ status: 404, body: "no" }, null],
    [{ status: 500 }, null],
    [{ body: "  " }, null],
    [{ body: "banana" }, "banana"],
    [new Error("ECONNRESET"), null],
  ]) {
    const r = await route(answer);
    assert.deepStrictEqual(r.route, draftOnly("unknown", seen));
    assert.strictEqual(snapshotRefusalFor(r.route).reason, "unknown");
  }
});
test("floor unset: draft-only for every release tag, server only on dev", async () => {
  const r = await route({ body: "30.01.01.00" }, null);
  assert.deepStrictEqual(r.route, draftOnly("floor-unset", "30.01.01.00", null));
  assert.deepStrictEqual(snapshotRefusalFor(r.route), {
    reason: "floor-unset",
    serverVersion: "30.01.01.00",
    required: null,
  });
  assert.strictEqual((await route({ body: "dev" }, null)).route.mode, "server");
  assert.strictEqual((await route({ status: 404 }, null)).route.reason, "unknown");
});
test("the real default floor is 26.11.09.00", async () => {
  const at = await resolvePushRoute({
    origin: "https://org.bluestep.net",
    fetchFn: fetcher({ body: "26.11.09.00" }).fn,
  });
  assert.strictEqual(at.reason, "at-or-above-floor");
  const below = await resolvePushRoute({
    origin: "https://org.bluestep.net",
    fetchFn: fetcher({ body: "26.11.02.04" }).fn,
  });
  assert.deepStrictEqual(below, draftOnly("below-floor", "26.11.02.04", "26.11.09.00"));
  const d = await resolvePushRoute({ origin: "https://org.bluestep.net", fetchFn: fetcher({ body: "dev" }).fn });
  assert.strictEqual(d.mode, "server");
});
test("a later floor applies to snapshot and plain pushes alike", async () => {
  assert.deepStrictEqual(
    (await route({ body: "26.11.02.05" }, "26.11.23.00")).route,
    draftOnly("below-floor", "26.11.02.05", "26.11.23.00")
  );
  assert.strictEqual((await route({ body: "26.11.23.00" }, "26.11.23.00")).route.mode, "server");
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
