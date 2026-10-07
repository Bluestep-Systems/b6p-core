// Behavioural specs for ComponentService (ClickUp 86bcd80mx): repo-URL parsing,
// repoName → catalog-id resolution with its cache, build submit + wait loop,
// status reads, and publish refusals surfacing the platform's own message.
//
// b6p-core has no test framework; this is a minimal, dependency-free node
// script (run via `npm test`). It exercises the COMPILED classes from dist/
// with a fake PlatformContext so no network is touched.
const assert = require("node:assert");
const { ComponentService } = require("../dist/component/ComponentService.js");
const { Err } = require("../dist/Err.js");

let failures = 0;
const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const REPO_URL = "https://config.example.net/git/component/revenue-tile.git";

/**
 * Build a ComponentService over a fake context whose csrfFetch answers from
 * `bodies` in order (each entry is the parsed JSON the GraphQL endpoint
 * returns; the last entry repeats). Returns { service, calls } where each call
 * records { url, query, variables }.
 */
function makeService(bodies) {
  const calls = [];
  const noop = () => {};
  const ctx = {
    logger: { debug: noop, info: noop, warn: noop, error: noop },
    prompt: { info: noop, error: noop },
    progress: { withProgress: async (tasks) => Promise.all(tasks.map((t) => t())) },
    fs: {},
    sessionManager: {
      csrfFetch: async (url, init) => {
        const parsed = JSON.parse(init.body);
        calls.push({ url: String(url), query: parsed.query, variables: parsed.variables });
        const body = bodies[Math.min(calls.length - 1, bodies.length - 1)];
        if (body.__httpStatus) {
          return new Response(body.__text ?? "server error", { status: body.__httpStatus });
        }
        if (body.__rawBody !== undefined) {
          return new Response(body.__rawBody, { status: 200 });
        }
        return new Response(JSON.stringify(body), { status: 200 });
      },
    },
    isDebugMode: () => false,
  };
  return { service: new ComponentService(ctx), calls };
}

function buildStatus(overrides) {
  return {
    buildId: "b-1",
    ref: "draft",
    sha: "abc123",
    state: "QUEUED",
    diagnostics: [],
    log: null,
    entryUrl: null,
    queuedAt: "2026-10-07T00:00:00Z",
    finishedAt: null,
    componentRowVersion: null,
    ...overrides,
  };
}

const CATALOG = { data: { customComponents: [{ topId: "120190___4", repoName: "revenue-tile" }] } };

// ── parseRepoUrl ─────────────────────────────────────────────────────

test("parseRepoUrl accepts the .git form and strips the suffix", () => {
  const ref = ComponentService.parseRepoUrl(REPO_URL);
  assert.deepStrictEqual(ref, { origin: "https://config.example.net", repoName: "revenue-tile" });
});

test("parseRepoUrl accepts the suffixless form", () => {
  const ref = ComponentService.parseRepoUrl("https://config.example.net/git/component/revenue-tile");
  assert.strictEqual(ref.repoName, "revenue-tile");
});

test("parseRepoUrl keeps a non-default port in the origin", () => {
  const ref = ComponentService.parseRepoUrl("https://localhost:8443/git/component/x.git");
  assert.strictEqual(ref.origin, "https://localhost:8443");
});

test("parseRepoUrl refuses a script repo URL", () => {
  assert.throws(
    () => ComponentService.parseRepoUrl("https://config.example.net/git/script/thing.git"),
    Err.ComponentUrlError
  );
});

test("parseRepoUrl refuses a bare origin and a non-URL", () => {
  assert.throws(() => ComponentService.parseRepoUrl("https://config.example.net"), Err.ComponentUrlError);
  assert.throws(() => ComponentService.parseRepoUrl("revenue-tile"), Err.ComponentUrlError);
});

test("parseRepoUrl refuses a nested path under the component route", () => {
  assert.throws(
    () => ComponentService.parseRepoUrl("https://config.example.net/git/component/a/b.git"),
    Err.ComponentUrlError
  );
});

test("parseRepoUrl refuses non-https schemes with ComponentUrlError", () => {
  // http would send the session token in the clear; ssh/git/file URLs have
  // origin "null" and used to surface later as a raw TypeError on new URL().
  for (const bad of [
    "http://config.example.net/git/component/x.git",
    "ssh://git@config.example.net/git/component/x.git",
    "git://config.example.net/git/component/x.git",
    "file:///git/component/x.git",
  ]) {
    assert.throws(() => ComponentService.parseRepoUrl(bad), Err.ComponentUrlError, bad);
  }
});

test("parseRepoUrl accepts a trailing slash", () => {
  const ref = ComponentService.parseRepoUrl("https://config.example.net/git/component/revenue-tile.git/");
  assert.strictEqual(ref.repoName, "revenue-tile");
});

test("parseRepoUrl refuses an empty repo name spelled as .git", () => {
  assert.throws(() => ComponentService.parseRepoUrl("https://config.example.net/git/component/.git"), Err.ComponentUrlError);
});

// ── resolveComponentId ───────────────────────────────────────────────

test("resolveComponentId finds the catalog row by repoName", async () => {
  const { service, calls } = makeService([CATALOG]);
  const id = await service.resolveComponentId({ origin: "https://config.example.net", repoName: "revenue-tile" });
  assert.strictEqual(id, "120190___4");
  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0].url.endsWith("/gql"), `gql endpoint, got ${calls[0].url}`);
  assert.match(calls[0].query, /customComponents/);
});

test("resolveComponentId caches per origin+name", async () => {
  const { service, calls } = makeService([CATALOG]);
  const ref = { origin: "https://config.example.net", repoName: "revenue-tile" };
  await service.resolveComponentId(ref);
  await service.resolveComponentId(ref);
  assert.strictEqual(calls.length, 1, "second resolution must not refetch the catalog");
});

test("resolveComponentId keys the cache by origin, not by name alone", async () => {
  const otherCatalog = { data: { customComponents: [{ topId: "999___1", repoName: "revenue-tile" }] } };
  const { service, calls } = makeService([CATALOG, otherCatalog]);
  const idA = await service.resolveComponentId({ origin: "https://a.example.net", repoName: "revenue-tile" });
  const idB = await service.resolveComponentId({ origin: "https://b.example.net", repoName: "revenue-tile" });
  assert.strictEqual(calls.length, 2, "a second origin must fetch its own catalog");
  assert.strictEqual(idA, "120190___4");
  assert.strictEqual(idB, "999___1");
});

test("resolveComponentId does not cache a miss", async () => {
  const empty = { data: { customComponents: [] } };
  const { service, calls } = makeService([empty, CATALOG]);
  const ref = { origin: "https://config.example.net", repoName: "revenue-tile" };
  await assert.rejects(service.resolveComponentId(ref), Err.ComponentNotFoundError);
  const id = await service.resolveComponentId(ref);
  assert.strictEqual(id, "120190___4", "a component created after the first fetch must be found");
  assert.strictEqual(calls.length, 2);
});

test("resolveComponentId names the known components when the name misses", async () => {
  const { service } = makeService([CATALOG]);
  await assert.rejects(
    service.resolveComponentId({ origin: "https://config.example.net", repoName: "nope" }),
    (e) => e instanceof Err.ComponentNotFoundError && e.knownNames.includes("revenue-tile")
  );
});

// ── build ────────────────────────────────────────────────────────────

test("build submits the mutation with the resolved id and the given ref", async () => {
  const { service, calls } = makeService([CATALOG, { data: { buildCustomComponent: buildStatus() } }]);
  const result = await service.build({ repoUrl: REPO_URL, ref: "draft" });
  assert.strictEqual(result.state, "QUEUED");
  assert.match(calls[1].query, /buildCustomComponent/);
  assert.deepStrictEqual(calls[1].variables, { id: "120190___4", ref: "draft" });
});

test("build sends ref: null when none is given, so the platform defaults it to draft", async () => {
  const { service, calls } = makeService([CATALOG, { data: { buildCustomComponent: buildStatus() } }]);
  await service.build({ repoUrl: REPO_URL });
  assert.strictEqual(calls[1].variables.ref, null);
});

test("build with wait polls until the build succeeds", async () => {
  const { service, calls } = makeService([
    CATALOG,
    { data: { buildCustomComponent: buildStatus({ state: "QUEUED" }) } },
    { data: { customComponentBuild: buildStatus({ state: "RUNNING" }) } },
    { data: { customComponentBuild: buildStatus({ state: "SUCCEEDED", entryUrl: "/component/revenue-tile/abc123/remoteEntry.js" }) } },
  ]);
  const result = await service.build({ repoUrl: REPO_URL, wait: true, pollIntervalMs: 0, timeoutMs: 5_000 });
  assert.strictEqual(result.state, "SUCCEEDED");
  assert.strictEqual(result.entryUrl, "/component/revenue-tile/abc123/remoteEntry.js");
  assert.match(calls[2].query, /customComponentBuild/);
  assert.deepStrictEqual(calls[2].variables, { id: "120190___4", sha: "abc123" });
});

test("build with wait returns a FAILED build rather than throwing", async () => {
  const failed = buildStatus({
    state: "FAILED",
    diagnostics: [{ severity: "ERROR", file: "src/Component.tsx", line: 3, column: 1, message: "boom" }],
  });
  const { service } = makeService([
    CATALOG,
    { data: { buildCustomComponent: buildStatus({ state: "QUEUED" }) } },
    { data: { customComponentBuild: failed } },
  ]);
  const result = await service.build({ repoUrl: REPO_URL, wait: true, pollIntervalMs: 0, timeoutMs: 5_000 });
  assert.strictEqual(result.state, "FAILED");
  assert.strictEqual(result.diagnostics[0].message, "boom");
});

test("build with wait returns a terminal submit answer without polling", async () => {
  // Idempotent resubmit of an already-succeeded commit answers SUCCEEDED directly.
  const { service, calls } = makeService([
    CATALOG,
    { data: { buildCustomComponent: buildStatus({ state: "SUCCEEDED" }) } },
  ]);
  const result = await service.build({ repoUrl: REPO_URL, wait: true, pollIntervalMs: 0, timeoutMs: 5_000 });
  assert.strictEqual(result.state, "SUCCEEDED");
  assert.strictEqual(calls.length, 2, "a terminal submit answer must not start the poll loop");
});

test("build with wait throws ComponentBuildTimeoutError when the budget elapses", async () => {
  const { service } = makeService([
    CATALOG,
    { data: { buildCustomComponent: buildStatus({ state: "QUEUED" }) } },
    { data: { customComponentBuild: buildStatus({ state: "RUNNING" }) } },
  ]);
  // A positive budget so the loop actually polls: the error must carry the
  // last state the polls observed, not the submit answer's.
  await assert.rejects(
    service.build({ repoUrl: REPO_URL, wait: true, pollIntervalMs: 0, timeoutMs: 50 }),
    (e) => e instanceof Err.ComponentBuildTimeoutError && e.lastState === "RUNNING" && e.buildId === "b-1"
  );
});

test("build with wait skips a stale terminal build of the same sha", async () => {
  // A resubmit after FAILED creates a new build; a poll racing the new record
  // can serve the old FAILED one. It must be skipped, not returned.
  const stale = buildStatus({ buildId: "b-old", state: "FAILED" });
  const { service } = makeService([
    CATALOG,
    { data: { buildCustomComponent: buildStatus({ buildId: "b-new", state: "QUEUED" }) } },
    { data: { customComponentBuild: stale } },
    { data: { customComponentBuild: buildStatus({ buildId: "b-new", state: "SUCCEEDED" }) } },
  ]);
  const result = await service.build({ repoUrl: REPO_URL, wait: true, pollIntervalMs: 0, timeoutMs: 5_000 });
  assert.strictEqual(result.buildId, "b-new");
  assert.strictEqual(result.state, "SUCCEEDED");
});

test("build with wait keeps polling through a null status read", async () => {
  const { service } = makeService([
    CATALOG,
    { data: { buildCustomComponent: buildStatus({ state: "QUEUED" }) } },
    { data: { customComponentBuild: null } },
    { data: { customComponentBuild: buildStatus({ state: "SUCCEEDED" }) } },
  ]);
  const result = await service.build({ repoUrl: REPO_URL, wait: true, pollIntervalMs: 0, timeoutMs: 5_000 });
  assert.strictEqual(result.state, "SUCCEEDED");
});

// ── status ───────────────────────────────────────────────────────────

test("status passes the sha through and returns the platform's answer", async () => {
  const { service, calls } = makeService([CATALOG, { data: { customComponentBuild: buildStatus() } }]);
  const result = await service.status({ repoUrl: REPO_URL, sha: "abc123" });
  assert.strictEqual(result.buildId, "b-1");
  assert.deepStrictEqual(calls[1].variables, { id: "120190___4", sha: "abc123" });
});

test("status answers null when nothing was ever built", async () => {
  const { service } = makeService([CATALOG, { data: { customComponentBuild: null } }]);
  const result = await service.status({ repoUrl: REPO_URL });
  assert.strictEqual(result, null);
});

// ── publish ──────────────────────────────────────────────────────────

test("publish returns the published build with the new componentRowVersion", async () => {
  const published = buildStatus({ state: "SUCCEEDED", componentRowVersion: 7 });
  const { service, calls } = makeService([CATALOG, { data: { publishCustomComponent: published } }]);
  const result = await service.publish({ repoUrl: REPO_URL });
  assert.strictEqual(result.componentRowVersion, 7);
  assert.match(calls[1].query, /publishCustomComponent/);
});

test("publish surfaces the platform's refusal text verbatim", async () => {
  const refusal =
    "No SUCCEEDED build of draft's current commit — run buildCustomComponent for this component and re-run publish once it reports SUCCEEDED";
  const { service } = makeService([CATALOG, { errors: [{ message: refusal }] }]);
  await assert.rejects(
    service.publish({ repoUrl: REPO_URL }),
    (e) => e instanceof Err.ComponentOperationError && e.messages[0] === refusal
  );
});

test("an HTTP failure throws HttpResponseError with the status code", async () => {
  const { service } = makeService([CATALOG, { __httpStatus: 502, __text: "bad gateway" }]);
  await assert.rejects(service.status({ repoUrl: REPO_URL }), (e) => e instanceof Err.HttpResponseError && /502/.test(e.message));
});

// ── Malformed answers ────────────────────────────────────────────────

test("a 200 that is not JSON throws ComponentOperationError, not a raw SyntaxError", async () => {
  const { service } = makeService([CATALOG, { __rawBody: "<html>proxy login page</html>" }]);
  await assert.rejects(service.status({ repoUrl: REPO_URL }), (e) => e instanceof Err.ComponentOperationError && /not JSON/.test(e.message));
});

test("data: null with no errors throws ComponentOperationError", async () => {
  const { service } = makeService([CATALOG, { data: null }]);
  await assert.rejects(service.status({ repoUrl: REPO_URL }), Err.ComponentOperationError);
});

test("a data object missing the mutation's root field throws, never returns undefined", async () => {
  const { service } = makeService([CATALOG, { data: {} }]);
  await assert.rejects(service.build({ repoUrl: REPO_URL }), (e) => e instanceof Err.ComponentOperationError && /buildCustomComponent/.test(e.message));
  const { service: pub } = makeService([CATALOG, { data: {} }]);
  await assert.rejects(pub.publish({ repoUrl: REPO_URL }), (e) => e instanceof Err.ComponentOperationError && /publishCustomComponent/.test(e.message));
});

test("a platform refusal evicts the cached id so a recreated component heals", async () => {
  const { service, calls } = makeService([
    CATALOG,
    { errors: [{ message: "unknown component id" }] },
    { data: { customComponents: [{ topId: "120190___9", repoName: "revenue-tile" }] } },
    { data: { customComponentBuild: null } },
  ]);
  await assert.rejects(service.status({ repoUrl: REPO_URL }), Err.ComponentOperationError);
  const result = await service.status({ repoUrl: REPO_URL });
  assert.strictEqual(result, null);
  assert.match(calls[2].query, /customComponents/, "the second call after a refusal must re-resolve the id");
  assert.strictEqual(calls[3].variables.id, "120190___9", "the recreated component's new id must be used");
});

// ── Runner ───────────────────────────────────────────────────────────

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ok    ${name}`);
    } catch (e) {
      failures++;
      console.error(`  FAIL  ${name}`);
      console.error(`        ${e && e.message ? e.message.split("\n")[0] : e}`);
    }
  }
  console.log(failures === 0 ? "ComponentService: all tests passed" : `ComponentService: ${failures} test(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
