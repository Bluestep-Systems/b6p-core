// Server version floor (rulings 42-43, ClickUp 86bczwj62): core no longer compiles or uploads `.build`,
// so a push (plain or snapshot) must first confirm the org's server runs the compileDraft/takeSnapshot
// flow. One constant, MIN_SERVER_VERSION, unset until the first web tag containing it exists. Covers the pure comparator and
// the gate, including through executePush against a fake context: a refusal must upload nothing.
// Dependency-free; runs the COMPILED classes from dist/ with no network or real filesystem.

const assert = require("node:assert");
const path = require("path");
const { B6PUri } = require("../dist/B6PUri.js");
const { Err } = require("../dist/Err.js");
const {
  parseReleaseTag,
  meetsMinimumVersion,
  assertServerVersion,
  MIN_SERVER_VERSION,
} = require("../dist/data/ServerVersion.js");
const { executePush } = require("../dist/script/push.js");

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

async function gate(answer, operation, floor = FLOOR) {
  const f = fetcher(answer);
  try {
    await assertServerVersion({ origin: "https://org.bluestep.net/files/1/draft", fetchFn: f.fn, operation, floor });
    return { error: null, calls: f.calls };
  } catch (e) {
    return { error: e, calls: f.calls };
  }
}

function expectRefusal(r, reason, serverVersion) {
  assert.ok(r.error instanceof Err.ServerVersionUnsupportedError, String(r.error));
  assert.strictEqual(r.error.reason, reason);
  assert.strictEqual(r.error.serverVersion, serverVersion);
}

test("asks /appinfo/version on the origin", async () => {
  const r = await gate({ body: FLOOR }, "push");
  assert.strictEqual(r.error, null);
  assert.deepStrictEqual(r.calls, ["https://org.bluestep.net/appinfo/version"]);
});
test("too-old plain push is refused with both versions", async () => {
  const r = await gate({ body: "26.11.02.05\n" }, "push");
  expectRefusal(r, "too-old", "26.11.02.05");
  assert.strictEqual(r.error.required, FLOOR);
  assert.strictEqual(r.error.operation, "push");
});
test("current and dev pass", async () => {
  assert.strictEqual((await gate({ body: "26.11.16.00" }, "push")).error, null);
  assert.strictEqual((await gate({ body: "dev" }, "push")).error, null);
});
test("404, 500, empty body, garbage and network failure are unknown", async () => {
  expectRefusal(await gate({ status: 404, body: "no" }, "push"), "unknown", null);
  expectRefusal(await gate({ status: 500 }, "push"), "unknown", null);
  expectRefusal(await gate({ body: "  " }, "push"), "unknown", null);
  expectRefusal(await gate({ body: "banana" }, "push"), "unknown", "banana");
  expectRefusal(await gate(new Error("ECONNRESET"), "push"), "unknown", null);
});
test("floor unset refuses plain and snapshot pushes except on dev", async () => {
  for (const operation of ["push", "snapshot"]) {
    const r = await gate({ body: "30.01.01.00" }, operation, null);
    expectRefusal(r, "floor-unset", "30.01.01.00");
    assert.strictEqual(r.error.required, null);
    assert.strictEqual(r.error.operation, operation);
    assert.strictEqual((await gate({ body: "dev" }, operation, null)).error, null);
    expectRefusal(await gate({ status: 404 }, operation, null), "unknown", null);
  }
});
test("the real default floor is the unset one: a release tag is refused, dev passes", async () => {
  const f = fetcher({ body: "30.01.01.00" });
  await assert.rejects(
    () => assertServerVersion({ origin: "https://org.bluestep.net", fetchFn: f.fn, operation: "snapshot" }),
    (e) => e instanceof Err.ServerVersionUnsupportedError && e.reason === "floor-unset"
  );
  const d = fetcher({ body: "dev" });
  await assertServerVersion({ origin: "https://org.bluestep.net", fetchFn: d.fn, operation: "push" });
});
test("snapshot push uses the same floor once set", async () => {
  expectRefusal(await gate({ body: "26.11.02.05" }, "snapshot", "26.11.23.00"), "too-old", "26.11.02.05");
  assert.strictEqual((await gate({ body: "26.11.23.00" }, "snapshot", "26.11.23.00")).error, null);
});

// ── executePush: a refusal uploads nothing ──
async function pushWith(answer, snapshot) {
  const requests = [];
  const ctx = {
    fs: { exists: async () => true },
    prompt: { error() {}, info() {}, warn() {}, confirm: async () => undefined, inputBox: async () => undefined },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    sessionManager: {
      fetch: async (url, init) => {
        requests.push(`${(init && init.method) || "GET"} ${url}`);
        if (answer instanceof Error) {
          throw answer;
        }
        return new Response(answer.body ?? "", { status: answer.status ?? 200 });
      },
    },
    progress: { withProgress: async () => assert.fail("must not upload") },
  };
  let error = null;
  try {
    await executePush({
      ctx,
      targetUrl: "https://org.bluestep.net/files/100001/draft",
      rootPath: path.join(path.parse(process.cwd()).root, "ws", "U100001", "MyScript"),
      snapshot,
    });
  } catch (e) {
    error = e;
  }
  return { error, requests };
}
test("executePush: a refused server version stops before any other request", async () => {
  const r = await pushWith({ body: "26.11.02.05" }, false);
  assert.ok(r.error instanceof Err.ServerVersionUnsupportedError);
  assert.deepStrictEqual(r.requests, ["GET https://org.bluestep.net/appinfo/version"]);
});
test("executePush: unreachable version endpoint refuses as unknown", async () => {
  const r = await pushWith(new Error("down"), false);
  assert.ok(r.error instanceof Err.ServerVersionUnsupportedError);
  assert.strictEqual(r.error.reason, "unknown");
});
test("executePush: a push refuses while the floor is unset", async () => {
  const r = await pushWith({ body: "40.01.01.00" }, true);
  assert.ok(r.error instanceof Err.ServerVersionUnsupportedError);
  assert.strictEqual(r.error.reason, "floor-unset");
  assert.strictEqual(r.requests.length, 1);
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
