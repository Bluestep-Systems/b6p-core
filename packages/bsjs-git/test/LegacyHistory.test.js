// Behavioral spec for the legacy history client and the saveState parser, against a stub HTTP server that mimics the
// contract: GET /api/v1/legacy-script-history/{scriptId}?limit&before -> [{id,author,timestamp,message}] newest
// first, GET .../{scriptId}/{entryId} -> the stored saveState. Dependency-free node script over the COMPILED dist/.

const assert = require("node:assert");
const http = require("node:http");
const lib = require("../dist/index.js");

const TOKEN = "b6pt_legacy";
const SCRIPT = "654015___1001";
const V1 = {
  version: 1,
  isSnapshot: true,
  settings: {
    "/src/": {},
    "/src/main.ts": { content: "export {};\n", external: false },
    "/logo.png": {},
  },
};
const V0 = {
  src: {
    files: {
      main: { name: "main", extension: "ts", content: "v0 main" },
      "gen.mjs": { name: "gen", extension: "mjs", content: "built" },
    },
  },
  readme: { name: "README", content: "readme text" },
};
const ENTRIES = [
  { id: "e3", author: "Cy", timestamp: "2026-03-03T00:00:00.000Z", message: "third" },
  { id: "e2", author: "Bo", timestamp: "2026-02-02T00:00:00.000Z" },
  { id: "e1", author: "Al", timestamp: "2026-01-01T00:00:00.000Z", message: "first" },
];
const requests = [];
const sessionRequests = [];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  requests.push(`${req.method} ${url.pathname}${url.search}`);
  const send = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const session = (req.headers.cookie || "").includes("JSESSIONID=legacy-session");
  if (url.pathname === "/csrf-token") {
    res.writeHead(session ? 200 : 401);
    return res.end("csrf-legacy");
  }
  if (session) {
    sessionRequests.push(req.headers["b6p-csrf-token"]);
    if (req.headers.authorization || req.headers["b6p-csrf-token"] !== "csrf-legacy") {
      return send(403, {});
    }
  } else if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    return send(401, {});
  }
  const base = `/api/v1/legacy-script-history/${SCRIPT}`;
  if (url.pathname === base) {
    const limit = Number(url.searchParams.get("limit") || 100);
    const before = url.searchParams.get("before");
    const start = before ? ENTRIES.findIndex((e) => e.id === before) + 1 : 0;
    return send(200, ENTRIES.slice(start, start + limit));
  }
  if (url.pathname === `${base}/e3`) {
    return send(200, V1);
  }
  if (url.pathname === `${base}/e1`) {
    return send(200, V0);
  }
  if (url.pathname === `${base}/e2`) {
    return send(200, "this is not a tree");
  }
  if (url.pathname.startsWith("/api/v1/legacy-script-history/654015___403")) {
    return send(403, {});
  }
  return send(404, {});
});

let failures = 0;
const pending = [];
function test(name, fn) {
  pending.push([name, fn]);
}

test("parseSaveState reads version 1: folders, text files, content-less files", () => {
  const tree = lib.parseSaveState(JSON.stringify(V1));
  assert.strictEqual(tree.version, 1);
  assert.deepStrictEqual(tree.entries, [
    { path: "/src/", kind: "folder" },
    { path: "/src/main.ts", kind: "file", content: "export {};\n", external: false },
    { path: "/logo.png", kind: "file" },
  ]);
  assert.deepStrictEqual([...lib.treeFiles(tree)], [["/src/main.ts", "export {};\n"]]);
});

test("parseSaveState reads version 0 into the same tree shape, skipping .mjs", () => {
  const tree = lib.parseSaveState(JSON.stringify(V0));
  assert.strictEqual(tree.version, 0);
  assert.deepStrictEqual(tree.entries, [
    { path: "/src/", kind: "folder" },
    { path: "/src/main.ts", kind: "file", content: "v0 main" },
    { path: "/README", kind: "file", content: "readme text" },
  ]);
});

test("parseSaveState refuses what is neither version", () => {
  assert.throws(() => lib.parseSaveState("nope"), lib.BadSaveStateError);
  assert.throws(() => lib.parseSaveState("[1]"), lib.BadSaveStateError);
  assert.throws(() => lib.parseSaveState(JSON.stringify({ version: 2, settings: {} })), lib.BadSaveStateError);
});

test("list pages newest first and sends the token, limit and before", async () => {
  const client = new lib.LegacyHistoryClient({ baseUrl: base, auth: { kind: "token", token: TOKEN } });
  const first = await client.list(SCRIPT, { limit: 2 });
  assert.deepStrictEqual(
    first.map((e) => e.id),
    ["e3", "e2"]
  );
  assert.strictEqual(first[1].message, undefined);
  const next = await client.list(SCRIPT, { limit: 2, before: "e2" });
  assert.deepStrictEqual(
    next.map((e) => e.id),
    ["e1"]
  );
  assert.ok(requests.includes(`GET /api/v1/legacy-script-history/${SCRIPT}?limit=2&before=e2`));
});

test("get parses the stored tree of either version", async () => {
  const client = new lib.LegacyHistoryClient({ baseUrl: base, auth: { kind: "token", token: TOKEN } });
  assert.strictEqual((await client.get(SCRIPT, "e3")).version, 1);
  assert.strictEqual((await client.get(SCRIPT, "e1")).version, 0);
  await assert.rejects(client.get(SCRIPT, "e2"), lib.BadSaveStateError);
});

test("refusals are typed", async () => {
  await assert.rejects(
    new lib.LegacyHistoryClient({ baseUrl: base, auth: { kind: "token", token: "b6pt_bad" } }).list(SCRIPT),
    lib.GitAuthError
  );
  const client = new lib.LegacyHistoryClient({ baseUrl: base, auth: { kind: "token", token: TOKEN } });
  await assert.rejects(client.list("654015___403"), lib.GitPermissionError);
  await assert.rejects(client.list("654015___404"), lib.GitRepoNotFoundError);
  await assert.rejects(client.get(SCRIPT, "missing"), lib.GitRepoNotFoundError);
});

test("session mode sends the cookie and the CSRF header and no Authorization", async () => {
  const browserFetch = (url, init) =>
    fetch(url, { ...init, headers: { ...init.headers, Cookie: "JSESSIONID=legacy-session" } });
  const client = new lib.LegacyHistoryClient({ baseUrl: base, auth: { kind: "session" }, fetch: browserFetch });
  assert.deepStrictEqual(
    (await client.list(SCRIPT, { limit: 1 })).map((e) => e.id),
    ["e3"]
  );
  assert.strictEqual((await client.get(SCRIPT, "e3")).version, 1);
  assert.deepStrictEqual(sessionRequests, ["csrf-legacy", "csrf-legacy"]);
});

let base;
(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}/`;
  for (const [name, fn] of pending) {
    try {
      await fn();
      console.log(`ok   - ${name}`);
    } catch (e) {
      failures++;
      console.error(`FAIL - ${name}\n       ${e.stack || e.message}`);
    }
  }
  server.close();
  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll LegacyHistory tests passed.");
})();
