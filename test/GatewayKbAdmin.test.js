// Behavioral spec for the global knowledge-base admin calls (`core.gateway.kb`): create, detail with its
// ETag, read by name, update with If-Match (428/412), the typed `access` union and its strictness, scope and
// error mapping, and that the token never reaches a message or log line. Runs the COMPILED dist/ against
// FakeGateway.

const assert = require("node:assert");
const { Err, FakeGateway, GatewayService, MockFileSystem } = require("../dist/index.js");

const TOKEN = "b6pt_spec_adminadmin0123456789";

let failures = 0;
const pending = [];
function test(name, fn) {
  pending.push([name, fn]);
}

const logLines = [];
const thrownMessages = [];
const log = (...args) => logLines.push(args.map(String).join(" "));
const logger = { info: log, warn: log, error: log, debug: log };

async function rejectsWith(promise, type) {
  try {
    await promise;
  } catch (error) {
    thrownMessages.push(error.message);
    assert.ok(error instanceof type, `expected ${type.name}, got ${error && error.name}: ${error && error.message}`);
    return error;
  }
  assert.fail(`expected ${type.name}, but it resolved`);
}

async function withAdmin(fn, scopes = ["kb:read", "kb:manage"]) {
  const fake = await FakeGateway.start();
  fake.grantToken(TOKEN, scopes);
  const service = new GatewayService({
    fs: new MockFileSystem(),
    sessionManager: null,
    logger,
    prompt: null,
    progress: null,
    isDebugMode: () => false,
    gatewayToken: { token: async () => TOKEN },
    gatewayUrl: async () => fake.url,
    fetchFn: globalThis.fetch.bind(globalThis),
  });
  try {
    await fn({ fake, kb: service.kb, client: service.client });
  } finally {
    await fake.stop();
  }
}

const sent = (fake, method) =>
  fake.requests.filter((r) => r.method === method && r.path.startsWith("/api/v1/knowledge-bases"));

test("create sends only what was given and returns the typed detail (private by default)", async () => {
  await withAdmin(async ({ fake, kb, client }) => {
    const made = await kb.create({ name: "docs" });
    assert.deepStrictEqual(JSON.parse(sent(fake, "POST")[0].body), { name: "docs" });
    assert.strictEqual(made.ref, "global/docs");
    assert.strictEqual(made.title, "docs");
    assert.strictEqual(made.liveBranch, "master");
    assert.deepStrictEqual(made.access, { kind: "private" });
    assert.ok(made.id.length > 0 && made.gitUrl.startsWith(fake.url));
  });
});

test("create with title, branch and access public sends all three in one request", async () => {
  await withAdmin(async ({ fake, kb, client }) => {
    const made = await kb.create({ name: "docs", title: "Docs", liveBranch: "main", access: { kind: "public" } });
    assert.strictEqual(sent(fake, "POST").length, 1);
    assert.deepStrictEqual(JSON.parse(sent(fake, "POST")[0].body), {
      name: "docs",
      title: "Docs",
      liveBranch: "main",
      access: { kind: "public" },
    });
    assert.deepStrictEqual(made.access, { kind: "public" });
    // the listing shows the access too
    const listed = await kb.list({ scope: "global" });
    assert.deepStrictEqual(listed[0].access, { kind: "public" });
  });
});

test("create refuses a taken name as a conflict (name-taken) and bad input before sending", async () => {
  await withAdmin(async ({ fake, kb, client }) => {
    await kb.create({ name: "docs" });
    const taken = await rejectsWith(kb.create({ name: "DOCS" }), Err.GatewayConflictError);
    assert.strictEqual(taken.code, "name-taken");
    const before = fake.requests.length;
    await rejectsWith(kb.create({ name: "" }), Err.GatewayInvalidArgumentError);
    await rejectsWith(kb.create({ name: "x", title: "  " }), Err.GatewayInvalidArgumentError);
    await rejectsWith(kb.create({ name: "x", access: { kind: "Public" } }), Err.GatewayInvalidArgumentError);
    await rejectsWith(
      kb.create({ name: "x", access: { kind: "unknown", rawKind: "z", raw: {} } }),
      Err.GatewayInvalidArgumentError
    );
    assert.strictEqual(fake.requests.length, before);
  });
});

test("detail returns the ETag; read resolves a global name to the id first", async () => {
  await withAdmin(async ({ fake, kb, client }) => {
    const made = await kb.create({ name: "docs" });
    const byId = await kb.detail(made.id);
    assert.strictEqual(byId.etag, '"1"');
    assert.deepStrictEqual(byId.kb, made);
    const byName = await kb.read("Docs");
    assert.deepStrictEqual(byName, byId);
    assert.strictEqual((await kb.read("global/docs")).kb.id, made.id);
    await rejectsWith(kb.read("nope"), Err.GatewayKnowledgeBaseError);
    await rejectsWith(kb.read("U1/docs"), Err.GatewayKnowledgeBaseError);
    await rejectsWith(kb.detail("00000000-0000-4000-8000-0000000000ff"), Err.GatewayNotFoundError);
    assert.ok(fake.requests.length > 0);
  });
});

test("update sends If-Match and every field in ONE PATCH, then the ETag moves on", async () => {
  await withAdmin(async ({ fake, kb, client }) => {
    const made = await kb.create({ name: "docs" });
    const v1 = await kb.detail(made.id);
    const changed = await kb.update(made.id, v1.etag, {
      title: "Docs",
      liveBranch: "main",
      access: { kind: "public" },
    });
    const patches = sent(fake, "PATCH");
    assert.strictEqual(patches.length, 1);
    assert.strictEqual(patches[0].ifMatch, '"1"');
    assert.deepStrictEqual(JSON.parse(patches[0].body), {
      title: "Docs",
      liveBranch: "main",
      access: { kind: "public" },
    });
    assert.deepStrictEqual(changed.access, { kind: "public" });
    assert.strictEqual((await kb.detail(made.id)).etag, '"2"');
  });
});

test("update sends access only when asked for", async () => {
  await withAdmin(async ({ fake, kb, client }) => {
    const made = await kb.create({ name: "docs", access: { kind: "public" } });
    const v = await kb.detail(made.id);
    const changed = await kb.update(made.id, v.etag, { title: "New" });
    assert.deepStrictEqual(JSON.parse(sent(fake, "PATCH")[0].body), { title: "New" });
    assert.deepStrictEqual(changed.access, { kind: "public" });
  });
});

test("a stale ETag is GatewayPreconditionFailedError (412) and changes nothing", async () => {
  await withAdmin(async ({ kb, client }) => {
    const made = await kb.create({ name: "docs" });
    const v1 = await kb.detail(made.id);
    await kb.update(made.id, v1.etag, { title: "First" });
    const err = await rejectsWith(kb.update(made.id, v1.etag, { title: "Second" }), Err.GatewayPreconditionFailedError);
    assert.strictEqual(err.status, 412);
    assert.strictEqual(err.code, "precondition-failed");
    assert.strictEqual((await kb.detail(made.id)).kb.title, "First");
  });
});

test("a missing If-Match is GatewayPreconditionRequiredError (428), as the gateway answers it", async () => {
  await withAdmin(async ({ fake, kb, client }) => {
    const made = await kb.create({ name: "docs" });
    // a caller that goes round the typed call and sends none
    const err = await rejectsWith(
      client.request("PATCH", `/api/v1/knowledge-bases/${made.id}`, { body: { title: "x" } }),
      Err.GatewayPreconditionRequiredError
    );
    assert.strictEqual(err.status, 428);
    assert.strictEqual(sent(fake, "PATCH")[0].ifMatch, undefined);
  });
});

test("update refuses an empty change, an empty ETag, an unknown access: nothing is sent", async () => {
  await withAdmin(async ({ fake, kb, client }) => {
    const made = await kb.create({ name: "docs" });
    const before = fake.requests.length;
    await rejectsWith(kb.update(made.id, '"1"', {}), Err.GatewayInvalidArgumentError);
    await rejectsWith(kb.update(made.id, "", { title: "x" }), Err.GatewayInvalidArgumentError);
    await rejectsWith(
      kb.update(made.id, '"1"', { access: { kind: "unknown", rawKind: "x", raw: {} } }),
      Err.GatewayInvalidArgumentError
    );
    await rejectsWith(kb.update(made.id, '"1"', { access: { kind: "PUBLIC" } }), Err.GatewayInvalidArgumentError);
    assert.strictEqual(fake.requests.length, before);
  });
});

test("a token without kb:manage gets GatewayScopeError naming kb:manage", async () => {
  await withAdmin(
    async ({ kb, client }) => {
      const e1 = await rejectsWith(kb.create({ name: "docs" }), Err.GatewayScopeError);
      assert.strictEqual(e1.scope, "kb:manage");
      const e2 = await rejectsWith(
        kb.update("00000000-0000-4000-8000-000000000001", '"1"', { title: "x" }),
        Err.GatewayScopeError
      );
      assert.strictEqual(e2.scope, "kb:manage");
    },
    ["kb:read"]
  );
});

test("a gateway that predates access answers 400: GatewayAccessRefusedError (still a GatewayInvalidRequestError)", async () => {
  await withAdmin(async ({ fake, kb, client }) => {
    fake.accessUnsupported = true;
    const err = await rejectsWith(
      kb.create({ name: "docs", access: { kind: "public" } }),
      Err.GatewayAccessRefusedError
    );
    assert.ok(err instanceof Err.GatewayInvalidRequestError);
    assert.strictEqual(err.status, 400);
    // without access it works, and the answer carries none
    const made = await kb.create({ name: "docs" });
    assert.strictEqual(made.access, undefined);
    const v = await kb.detail(made.id);
    await rejectsWith(kb.update(made.id, v.etag, { access: { kind: "private" } }), Err.GatewayAccessRefusedError);
    // another 400 (no access in the request) stays a plain invalid request
    const plain = await rejectsWith(
      client.request("PATCH", `/api/v1/knowledge-bases/${made.id}`, {
        body: { bogus: 1 },
        headers: { "If-Match": v.etag },
      }),
      Err.GatewayInvalidRequestError
    );
    assert.ok(!(plain instanceof Err.GatewayAccessRefusedError));
  });
});

test("an unknown access kind reads as unknown (never public), with the raw value kept", async () => {
  await withAdmin(async ({ fake, kb, client }) => {
    const made = await kb.create({ name: "docs" });
    const row = fake.knowledgeBases.find((k) => k.id === made.id);
    for (const [raw, rawKind] of [
      [{ kind: "scoped", permissions: ["x"] }, "scoped"],
      [{ kind: "Public" }, "Public"],
      [{ kind: "public", permissions: [] }, "public"],
      [{ kind: 5 }, null],
      ["public", null],
    ]) {
      row.access = raw;
      const got = (await kb.detail(made.id)).kb.access;
      assert.strictEqual(got.kind, "unknown", JSON.stringify(raw));
      assert.strictEqual(got.rawKind, rawKind);
      assert.deepStrictEqual(got.raw, raw);
      assert.strictEqual((await kb.list({ scope: "global" }))[0].access.kind, "unknown");
    }
  });
});

test("an unknown access read from the gateway cannot be written back through update", async () => {
  await withAdmin(async ({ fake, kb, client }) => {
    const made = await kb.create({ name: "docs" });
    fake.knowledgeBases.find((k) => k.id === made.id).access = { kind: "scoped" };
    const v = await kb.detail(made.id);
    await rejectsWith(kb.update(made.id, v.etag, { access: v.kb.access }), Err.GatewayInvalidArgumentError);
    // a title-only change does not send access, so the unknown value is left as read
    await kb.update(made.id, v.etag, { title: "T" });
    assert.deepStrictEqual(fake.knowledgeBases.find((k) => k.id === made.id).access, { kind: "scoped" });
  });
});

test("a detail without an ETag, or a malformed body, is GatewayUnexpectedResponseError", async () => {
  await withAdmin(async ({ fake, kb, client }) => {
    const id = "00000000-0000-4000-8000-000000000009";
    fake.route({
      method: "GET",
      prefix: `/api/v1/knowledge-bases/${id}`,
      scope: "kb:manage",
      handler: (req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ id, ref: "global/x", name: "x", title: "x", liveBranch: "master", gitUrl: "http://x/y.git" })
        );
      },
    });
    await rejectsWith(kb.detail(id), Err.GatewayUnexpectedResponseError);
  });
  await withAdmin(async ({ fake, kb, client }) => {
    const id = "00000000-0000-4000-8000-000000000009";
    fake.route({
      method: "GET",
      prefix: `/api/v1/knowledge-bases/${id}`,
      scope: "kb:manage",
      handler: (req, res) => {
        res.writeHead(200, { "content-type": "application/json", etag: '"1"' });
        res.end(JSON.stringify({ id, name: "x" }));
      },
    });
    await rejectsWith(kb.detail(id), Err.GatewayUnexpectedResponseError);
  });
});

test("requestDetailed exposes status and ETag; request still returns the body alone", async () => {
  await withAdmin(async ({ kb, client }) => {
    const made = await kb.create({ name: "docs" });
    const path = `/api/v1/knowledge-bases/${made.id}`;
    const detailed = await client.requestDetailed("GET", path);
    assert.strictEqual(detailed.status, 200);
    assert.strictEqual(detailed.etag, '"1"');
    assert.strictEqual(detailed.body.name, "docs");
    assert.strictEqual((await client.request("GET", path)).name, "docs");
  });
});

(async () => {
  for (const [name, fn] of pending) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (error) {
      failures++;
      console.error(`  ✗ ${name}\n    ${error && error.stack}`);
    }
  }
  const leaks = [...thrownMessages, ...logLines].filter((line) => line.includes(TOKEN));
  if (thrownMessages.length === 0 || leaks.length > 0) {
    failures++;
    console.error(`  ✗ the token never appears in a thrown message or log line\n    ${leaks.join("\n    ")}`);
  } else {
    console.log(
      `  ✓ the token never appears in a thrown message or log line (${thrownMessages.length} errors, ${logLines.length} log lines)`
    );
  }
  if (failures > 0) {
    console.error(`\nGatewayKbAdmin: ${failures} failing`);
    process.exit(1);
  }
  console.log(`\nGatewayKbAdmin: all ${pending.length + 1} passing`);
})();
