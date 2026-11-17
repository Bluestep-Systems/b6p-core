// Server version floor and route: core never compiles, so a push first confirms the org's server builds a git-pushed
// draft (GraphQL compileDraft with expectedDraftSha, web CU-1k5g91bq6u2). One constant, MIN_SERVER_VERSION, which
// stays null (unset) until the first web tag with that build is cut. A server below it (or an unreadable version, or
// the floor unset) is not refused: it gets the push-only route. Covers the pure comparator, resolvePushRoute and
// snapshotRefusalFor; the end-to-end routing is in GitDraftSync.test.js.
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
// The release guard: with the floor unset every release server takes the push-only route, so no snapshot could
// publish. A 1.0.0 (or later) package.json with MIN_SERVER_VERSION still null must fail the suite.
test("release guard: version 1.0.0 or later needs MIN_SERVER_VERSION set to a release tag", () => {
  const { version } = require("../package.json");
  const major = Number(String(version).split(".")[0]);
  if (major >= 1) {
    assert.notStrictEqual(
      MIN_SERVER_VERSION,
      null,
      `package.json is ${version} but MIN_SERVER_VERSION is null: set it to the first web tag with the git build`
    );
  }
  if (MIN_SERVER_VERSION !== null) {
    assert.ok(parseReleaseTag(MIN_SERVER_VERSION), `MIN_SERVER_VERSION ${MIN_SERVER_VERSION} is not a release tag`);
  }
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
const pushOnly = (reason, serverVersion, required = FLOOR) => ({
  mode: "push-only",
  reason,
  serverVersion,
  required,
});

test("asks /appinfo/version on the origin", async () => {
  const r = await route({ body: FLOOR });
  assert.deepStrictEqual(r.calls, ["https://org.bluestep.net/appinfo/version"]);
  assert.deepStrictEqual(r.route, {
    mode: "server-build",
    reason: "at-or-above-floor",
    serverVersion: FLOOR,
    required: FLOOR,
  });
});
test("below the floor is push-only with both versions, never an error", async () => {
  const r = await route({ body: "26.11.02.05\n" });
  assert.deepStrictEqual(r.route, pushOnly("below-floor", "26.11.02.05"));
  assert.deepStrictEqual(snapshotRefusalFor(r.route), {
    reason: "too-old",
    serverVersion: "26.11.02.05",
    required: FLOOR,
  });
});
test("current and dev take the build route, which refuses no snapshot", async () => {
  const cur = await route({ body: "26.11.16.00" });
  assert.strictEqual(cur.route.mode, "server-build");
  assert.strictEqual(snapshotRefusalFor(cur.route), null);
  const dev = await route({ body: "dev" });
  assert.deepStrictEqual(dev.route, { mode: "server-build", reason: "dev", serverVersion: "dev", required: FLOOR });
  assert.strictEqual(snapshotRefusalFor(dev.route), null);
  const latest = await route({ body: "latest" });
  assert.deepStrictEqual(latest.route, {
    mode: "server-build",
    reason: "dev",
    serverVersion: "latest",
    required: FLOOR,
  });
  assert.strictEqual(snapshotRefusalFor(latest.route), null);
});
test("404, 500, empty body, garbage and network failure are push-only, unknown", async () => {
  for (const [answer, seen] of [
    [{ status: 404, body: "no" }, null],
    [{ status: 500 }, null],
    [{ body: "  " }, null],
    [{ body: "banana" }, "banana"],
    [new Error("ECONNRESET"), null],
  ]) {
    const r = await route(answer);
    assert.deepStrictEqual(r.route, pushOnly("unknown", seen));
    assert.strictEqual(snapshotRefusalFor(r.route).reason, "unknown");
  }
});
test("floor unset: push-only for every release tag, server only on dev", async () => {
  const r = await route({ body: "30.01.01.00" }, null);
  assert.deepStrictEqual(r.route, pushOnly("floor-unset", "30.01.01.00", null));
  assert.deepStrictEqual(snapshotRefusalFor(r.route), {
    reason: "floor-unset",
    serverVersion: "30.01.01.00",
    required: null,
  });
  assert.strictEqual((await route({ body: "dev" }, null)).route.mode, "server-build");
  assert.strictEqual((await route({ status: 404 }, null)).route.reason, "unknown");
});
test("the real default floor (26.11.16.00): older release lines are push-only, today's and later build; dev builds", async () => {
  const older = await resolvePushRoute({
    origin: "https://org.bluestep.net",
    fetchFn: fetcher({ body: "26.11.09.02" }).fn,
  });
  assert.deepStrictEqual(older, pushOnly("below-floor", "26.11.09.02", "26.11.16.00"));
  for (const body of ["26.11.16.00", "26.11.17.00", "26.11.23.01"]) {
    const r = await resolvePushRoute({ origin: "https://org.bluestep.net", fetchFn: fetcher({ body }).fn });
    assert.strictEqual(r.mode, "server-build", body);
  }
  const d = await resolvePushRoute({ origin: "https://org.bluestep.net", fetchFn: fetcher({ body: "dev" }).fn });
  assert.strictEqual(d.mode, "server-build");
});
test("a later floor applies to snapshot and plain pushes alike", async () => {
  assert.deepStrictEqual(
    (await route({ body: "26.11.02.05" }, "26.11.23.00")).route,
    pushOnly("below-floor", "26.11.02.05", "26.11.23.00")
  );
  assert.strictEqual((await route({ body: "26.11.23.00" }, "26.11.23.00")).route.mode, "server-build");
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
