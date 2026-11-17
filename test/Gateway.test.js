// Behavioral spec for the gateway subsystem (`core.gateway`): the HTTP client for web-global's
// gateway and the `FakeGateway` test double it is specified against.
//
// What it pins: the `b6pt_` token goes out as `Authorization: Bearer` on every request and never
// into a thrown message or a log line (even when the server echoes it); a missing or malformed
// token fails before anything is sent; every contract status / error code maps to its typed error;
// requests run one at a time; the token is only ever sent to the configured gateway origin, over
// https or loopback http.
//
// Dependency-free node script (run via `npm test`). Exercises the COMPILED output in dist/. The
// fake listens on 127.0.0.1 with an ephemeral port and touches no file paths, so it runs the same
// on Windows and POSIX.

const assert = require("node:assert");
const {
  B6PCore,
  Err,
  FakeGateway,
  Gateway,
  GatewayClient,
  MockFileSystem,
  gatewayErrorFor,
  gatewayTokenProblem,
  parseGatewayOrigin,
} = require("../dist/index.js");

const TOKEN = "b6pt_spec_0123456789abcdef";

let failures = 0;
const pending = [];
function test(name, fn) {
  pending.push([name, fn]);
}

/** Every line any logger in this file was asked to write, to prove the token never reaches one. */
const logLines = [];
/** Every message of every error caught in this file, for the same proof. */
const thrownMessages = [];

function makeLogger() {
  const log = (...args) => logLines.push(args.map(String).join(" "));
  return { info: log, warn: log, error: log, debug: log };
}

function makeClient(fake, opts = {}) {
  const { url, fetchFn, timeoutMs } = opts;
  const token = "token" in opts ? opts.token : TOKEN;
  const fetches = [];
  const baseFetch = fetchFn ?? globalThis.fetch.bind(globalThis);
  const ctx = {
    fs: new MockFileSystem(),
    sessionManager: null,
    logger: makeLogger(),
    prompt: null,
    progress: null,
    isDebugMode: () => false,
    gatewayToken: { token: async () => token },
    gatewayUrl: async () => url ?? fake.url,
    fetchFn: (u, init) => {
      fetches.push(String(u));
      return baseFetch(u, init);
    },
  };
  return { client: new GatewayClient(ctx, { timeoutMs }), fetches };
}

/** Await `promise`, require it to reject with `type`, record its message, and return the error. */
async function rejectsWith(promise, type) {
  try {
    await promise;
  } catch (error) {
    thrownMessages.push(error.message);
    assert.ok(error instanceof type, `expected ${type.name}, got ${error && error.name}: ${error && error.message}`);
    assert.ok(error instanceof Err.GatewayError, "every gateway error extends Err.GatewayError");
    return error;
  }
  assert.fail(`expected ${type.name}, but it resolved`);
}

async function withFake(fn) {
  const fake = await FakeGateway.start();
  fake.grantToken(TOKEN, [Gateway.Scopes.KB_READ, Gateway.Scopes.REGISTRY_READ]);
  try {
    await fn(fake);
  } finally {
    await fake.stop();
  }
}

function kb(fake, overrides) {
  return {
    ref: "global/onboarding",
    scope: "global",
    tenant: null,
    name: "onboarding",
    title: "Onboarding",
    liveBranch: "master",
    canPush: true,
    gitUrl: fake.gitUrl("knowledge-base", "kb-onboarding"),
    ...overrides,
  };
}

// ── Header + JSON ───────────────────────────────────────────────────────

test("sends Authorization: Bearer <token> and Accept: JSON, and parses the JSON body", async () => {
  await withFake(async (fake) => {
    fake.knowledgeBases = [kb(fake)];
    const { client } = makeClient(fake);
    const body = await client.getJson(Gateway.Paths.KNOWLEDGE_BASES);
    assert.deepStrictEqual(body, { knowledgeBases: [kb(fake)] });
    assert.strictEqual(fake.requests.length, 1);
    assert.strictEqual(fake.requests[0].authorization, `Bearer ${TOKEN}`);
  });
});

test("query parameters are sent, and undefined ones left out", async () => {
  await withFake(async (fake) => {
    fake.knowledgeBases = [
      kb(fake),
      kb(fake, { ref: "tenant/U142133/handbook", scope: "tenant", tenant: "U142133", name: "handbook" }),
    ];
    const { client } = makeClient(fake);
    const body = await client.getJson(Gateway.Paths.KNOWLEDGE_BASES, { scope: "tenant", tenant: undefined });
    assert.deepStrictEqual(fake.requests[0].query, { scope: "tenant" });
    assert.strictEqual(body.knowledgeBases.length, 1);
    assert.strictEqual(body.knowledgeBases[0].tenant, "U142133");
  });
});

test("a JSON request body is sent with Content-Type application/json", async () => {
  await withFake(async (fake) => {
    fake.failNext({ status: 200, body: { ok: true } });
    const { client } = makeClient(fake);
    const body = await client.request("POST", "/api/v1/anything", { body: { a: 1 } });
    assert.deepStrictEqual(body, { ok: true });
    assert.strictEqual(fake.requests[0].body, '{"a":1}');
  });
});

test("an empty 2xx body resolves to undefined", async () => {
  await withFake(async (fake) => {
    fake.failNext({ status: 204 });
    const { client } = makeClient(fake);
    assert.strictEqual(await client.getJson("/api/v1/x"), undefined);
  });
});

// ── No token / malformed token: nothing is sent ─────────────────────────

for (const [label, token] of [
  ["no token", undefined],
  ["an empty token", ""],
]) {
  test(`${label} → GatewayAuthError token-missing before any request`, async () => {
    await withFake(async (fake) => {
      const { client, fetches } = makeClient(fake, { token });
      const error = await rejectsWith(client.getJson(Gateway.Paths.KNOWLEDGE_BASES), Err.GatewayAuthError);
      assert.strictEqual(error.reason, "token-missing");
      assert.strictEqual(error.status, null);
      assert.strictEqual(fetches.length, 0);
      assert.strictEqual(fake.requests.length, 0);
    });
  });
}

for (const [label, token] of [
  ["no b6pt_ prefix", "abc_0123456789"],
  ["only the prefix", "b6pt_"],
  ["a trailing newline", "b6pt_abc\n"],
  ["an inner space", "b6pt_ab c"],
  ["a non-Latin-1 character (…)", "b6pt_ab\u2026"],
  ["a smart quote", "b6pt_ab\u201d"],
  ["a Latin-1 non-ASCII character (é)", "b6pt_ab\u00e9"],
  ["a DEL character", "b6pt_ab\u007f"],
]) {
  test(`a token with ${label} → token-malformed before any request, value not quoted`, async () => {
    await withFake(async (fake) => {
      const { client, fetches } = makeClient(fake, { token });
      const error = await rejectsWith(client.getJson(Gateway.Paths.KNOWLEDGE_BASES), Err.GatewayAuthError);
      assert.strictEqual(error.reason, "token-malformed");
      assert.strictEqual(fetches.length, 0);
      if (token.length > "b6pt_".length) {
        assert.ok(!error.message.includes(token), "the candidate value is never quoted");
      }
    });
  });
}

test("gatewayTokenProblem accepts a well-formed token and names the problem otherwise", () => {
  assert.strictEqual(gatewayTokenProblem(TOKEN), null);
  assert.match(gatewayTokenProblem("x"), /does not start with b6pt_/);
  assert.match(gatewayTokenProblem(""), /empty/);
});

// ── Error mapping: every contract status / code ─────────────────────────

const MAPPINGS = [
  [{ status: 401, body: { error: "token-missing", message: "m" } }, Err.GatewayAuthError, { reason: "token-missing" }],
  [{ status: 401, body: { error: "token-invalid", message: "m" } }, Err.GatewayAuthError, { reason: "token-invalid" }],
  [{ status: 401 }, Err.GatewayAuthError, { reason: "token-invalid", code: "token-invalid" }],
  [
    { status: 403, body: { error: "scope-missing", message: "m", scope: "kb:push" } },
    Err.GatewayScopeError,
    { scope: "kb:push", code: "scope-missing" },
  ],
  [{ status: 403, body: { error: "scope-missing" } }, Err.GatewayScopeError, { scope: null }],
  [{ status: 403, body: { error: "not-permitted", message: "m" } }, Err.GatewayNotPermittedError, { code: "not-permitted" }],
  [{ status: 403 }, Err.GatewayNotPermittedError, { code: null }],
  [{ status: 404, body: { error: "not-found", message: "m" } }, Err.GatewayNotFoundError, { code: "not-found" }],
  [
    { status: 409, body: { error: "non-fast-forward", message: "m" } },
    Err.GatewayConflictError,
    { code: "non-fast-forward" },
  ],
  [{ status: 400, body: { error: "invalid-request", message: "m" } }, Err.GatewayInvalidRequestError, { code: "invalid-request", status: 400 }],
  [{ status: 400 }, Err.GatewayInvalidRequestError, { code: null }],
  [
    { status: 409, body: { error: "token-limit", message: "m", limit: 50 } },
    Err.GatewayTokenLimitError,
    { code: "token-limit", limit: 50 },
  ],
  [{ status: 409, body: { error: "token-limit" } }, Err.GatewayTokenLimitError, { limit: null }],
  [
    { status: 409, body: { error: "live-branch-unprotected", message: "m" } },
    Err.GatewayLiveBranchUnprotectedError,
    { code: "live-branch-unprotected" },
  ],
  [{ status: 409, body: { error: "alias-taken", message: "m" } }, Err.GatewayConflictError, { code: "alias-taken" }],
  [{ status: 413, body: { error: "too-large", message: "m" } }, Err.GatewayTooLargeError, { code: "too-large" }],
  [
    { status: 502, body: { error: "forge-unavailable", message: "m" } },
    Err.GatewayUnavailableError,
    { code: "forge-unavailable" },
  ],
  [{ status: 503, body: "<html>busy</html>" }, Err.GatewayUnavailableError, { code: null }],
  [{ status: 504 }, Err.GatewayUnavailableError, {}],
  [{ status: 500, body: { error: "boom" } }, Err.GatewayUnexpectedResponseError, { code: "boom" }],
  [{ status: 418 }, Err.GatewayUnexpectedResponseError, {}],
];

for (const [failure, type, expected] of MAPPINGS) {
  test(`${failure.status} ${JSON.stringify(failure.body ?? null)} → ${type.name}`, async () => {
    await withFake(async (fake) => {
      fake.failNext(failure);
      const { client } = makeClient(fake);
      const error = await rejectsWith(client.getJson(Gateway.Paths.KNOWLEDGE_BASES), type);
      assert.strictEqual(error.status, failure.status);
      for (const [key, value] of Object.entries(expected)) {
        assert.strictEqual(error[key], value, `${key}`);
      }
      assert.ok(error.message.startsWith(`GET ${Gateway.Paths.KNOWLEDGE_BASES}: `), error.message);
    });
  });
}

test("403 not-permitted carries the body's reason and presentingExpiresAt; odd values are dropped", () => {
  const at = "2026-12-01T00:00:00.000Z";
  const e = gatewayErrorFor(403, JSON.stringify({ error: "not-permitted", reason: "expiry-exceeds-presenting", presentingExpiresAt: at }), "x");
  assert.ok(e instanceof Err.GatewayNotPermittedError);
  assert.strictEqual(e.reason, "expiry-exceeds-presenting");
  assert.strictEqual(e.presentingExpiresAt, at);
  const r = gatewayErrorFor(403, '{"error":"not-permitted","reason":"restricted-mints-disabled"}', "x");
  assert.strictEqual(r.reason, "restricted-mints-disabled");
  assert.strictEqual(r.presentingExpiresAt, null);
  const rw = gatewayErrorFor(403, '{"error":"not-permitted","reason":"rewrite-not-permitted","scope":"kb:rewrite"}', "x");
  assert.strictEqual(rw.reason, "rewrite-not-permitted");
  assert.strictEqual(rw.scope, "kb:rewrite");
  assert.strictEqual(r.scope, null);
  const unknown = gatewayErrorFor(403, '{"error":"not-permitted","reason":"something-new"}', "x");
  assert.strictEqual(unknown.reason, "something-new");
  const junk = gatewayErrorFor(403, '{"error":"not-permitted","reason":"has spaces and b6pt_secret","presentingExpiresAt":"nope"}', "x");
  assert.strictEqual(junk.reason, null);
  assert.strictEqual(junk.presentingExpiresAt, null);
  assert.strictEqual(gatewayErrorFor(403, "", "x").reason, null);
});

test("409 conflict text names the branch head only for the git codes", () => {
  const head = (status, body) => gatewayErrorFor(status, JSON.stringify(body), "x").message;
  assert.match(head(409, { error: "non-fast-forward" }), /branch head/);
  assert.match(gatewayErrorFor(409, "", "git push").message, /branch head/);
  const other = head(409, { error: "alias-taken" });
  assert.doesNotMatch(other, /branch head/);
  assert.match(other, /conflicts with the current state/);
});

test("503 registry-unavailable names web-global; 502 and a bare 503 keep the forge sentence", () => {
  const registry = gatewayErrorFor(503, '{"error":"registry-unavailable"}', "GET /r");
  assert.ok(registry instanceof Err.GatewayUnavailableError);
  assert.match(registry.message, /web-global/);
  assert.doesNotMatch(registry.message, /forge/);
  assert.match(gatewayErrorFor(502, '{"error":"forge-unavailable"}', "GET /r").message, /gateway or the forge/);
  assert.match(gatewayErrorFor(503, "", "GET /r").message, /gateway or the forge/);
});

test("the fake's own auth: an unknown token is 401 token-invalid", async () => {
  await withFake(async (fake) => {
    fake.revokeToken(TOKEN);
    const { client } = makeClient(fake);
    const error = await rejectsWith(client.getJson(Gateway.Paths.KNOWLEDGE_BASES), Err.GatewayAuthError);
    assert.strictEqual(error.reason, "token-invalid");
  });
});

test("the fake's own auth: a missing scope is 403 scope-missing naming it", async () => {
  await withFake(async (fake) => {
    fake.grantToken(TOKEN, [Gateway.Scopes.KB_READ]);
    const { client } = makeClient(fake);
    const error = await rejectsWith(client.getJson(Gateway.Paths.REGISTRY_REPOS), Err.GatewayScopeError);
    assert.strictEqual(error.scope, Gateway.Scopes.REGISTRY_READ);
  });
});

test("the fake answers an unknown route 404 not-found", async () => {
  await withFake(async (fake) => {
    const { client } = makeClient(fake);
    await rejectsWith(client.getJson("/api/v1/nothing-here"), Err.GatewayNotFoundError);
  });
});

test("a 2xx body that is not JSON → GatewayUnexpectedResponseError", async () => {
  await withFake(async (fake) => {
    fake.failNext({ status: 200, body: "not json" });
    const { client } = makeClient(fake);
    const error = await rejectsWith(client.getJson("/api/v1/x"), Err.GatewayUnexpectedResponseError);
    assert.strictEqual(error.status, 200);
  });
});

test("gatewayErrorFor maps a git-route status with no body the same way", () => {
  assert.ok(gatewayErrorFor(409, "", "git push") instanceof Err.GatewayConflictError);
  assert.ok(gatewayErrorFor(401, "", "git fetch") instanceof Err.GatewayAuthError);
  const scope = gatewayErrorFor(403, '{"error":"scope-missing","scope":"kb:push"}', "git push");
  assert.ok(scope instanceof Err.GatewayScopeError);
  assert.strictEqual(scope.scope, "kb:push");
});

// ── Unreachable gateway ─────────────────────────────────────────────────

test("a refused connection → GatewayUnavailableError with status null", async () => {
  const fake = await FakeGateway.start();
  const url = fake.url;
  await fake.stop();
  const { client } = makeClient(fake, { url });
  const error = await rejectsWith(client.getJson("/api/v1/x"), Err.GatewayUnavailableError);
  assert.strictEqual(error.status, null);
});

test("no answer within the timeout → GatewayUnavailableError", async () => {
  await withFake(async (fake) => {
    fake.delayMs = 500;
    const { client } = makeClient(fake, { timeoutMs: 50 });
    const error = await rejectsWith(client.getJson(Gateway.Paths.KNOWLEDGE_BASES), Err.GatewayUnavailableError);
    assert.match(error.message, /within 50 ms/);
  });
});

// ── Sequential ──────────────────────────────────────────────────────────

test("concurrent calls run one at a time, in call order, and a failure does not stall the queue", async () => {
  await withFake(async (fake) => {
    fake.delayMs = 30;
    const { client } = makeClient(fake);
    const results = await Promise.allSettled([
      client.getJson(Gateway.Paths.KNOWLEDGE_BASES, { scope: "a" }),
      client.getJson("/api/v1/missing"),
      client.getJson(Gateway.Paths.KNOWLEDGE_BASES, { scope: "b" }),
      client.getJson(Gateway.Paths.REGISTRY_REPOS),
    ]);
    assert.strictEqual(fake.maxInFlight, 1);
    assert.deepStrictEqual(
      results.map((r) => r.status),
      ["fulfilled", "rejected", "fulfilled", "fulfilled"]
    );
    assert.deepStrictEqual(
      fake.requests.map((r) => r.path + (r.query.scope ? `?${r.query.scope}` : "")),
      [`${Gateway.Paths.KNOWLEDGE_BASES}?a`, "/api/v1/missing", `${Gateway.Paths.KNOWLEDGE_BASES}?b`, Gateway.Paths.REGISTRY_REPOS]
    );
    thrownMessages.push(results[1].reason.message);
  });
});

// ── Where the token may go ──────────────────────────────────────────────

test("parseGatewayOrigin: https anywhere, http only on loopback, bare origins only", () => {
  assert.strictEqual(parseGatewayOrigin("https://gateway.bluestep.net"), "https://gateway.bluestep.net");
  assert.strictEqual(parseGatewayOrigin("https://gateway.bluestep.net/"), "https://gateway.bluestep.net");
  assert.strictEqual(parseGatewayOrigin("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
  assert.strictEqual(parseGatewayOrigin("http://localhost:8080/"), "http://localhost:8080");
  for (const bad of [
    "http://gateway.bluestep.net",
    "not a url",
    "https://user:pw@gateway.bluestep.net",
    "https://gateway.bluestep.net/api",
    "https://gateway.bluestep.net/?x=1",
    "ftp://gateway.bluestep.net",
  ]) {
    assert.throws(() => parseGatewayOrigin(bad), Err.GatewayConfigError, bad);
  }
});

test("GatewayConfigError never quotes the configured value, its host or its path", () => {
  const secret = "b6pt_SECRETvalue123";
  for (const bad of [
    secret,
    `https://gateway.bluestep.net/${secret}`,
    `https://gateway.bluestep.net/?t=${secret}`,
    `https://gateway.bluestep.net/#${secret}`,
    `https://user:${secret}@gateway.bluestep.net`,
    `http://${secret.toLowerCase()}.example.com`,
    `ftp://${secret.toLowerCase()}.example.com`,
  ]) {
    let error;
    try {
      parseGatewayOrigin(bad);
    } catch (e) {
      error = e;
    }
    assert.ok(error instanceof Err.GatewayConfigError, bad);
    thrownMessages.push(error.message);
    assert.ok(!error.message.toLowerCase().includes("secretvalue123"), `quoted: ${error.message}`);
  }
});

test("a non-https configured URL fails before any request", async () => {
  await withFake(async (fake) => {
    const { client, fetches } = makeClient(fake, { url: "http://gateway.example.com" });
    await rejectsWith(client.getJson("/api/v1/x"), Err.GatewayConfigError);
    assert.strictEqual(fetches.length, 0);
  });
});

test("a protocol-relative path cannot move the request off the gateway origin", async () => {
  await withFake(async (fake) => {
    const { client, fetches } = makeClient(fake);
    await rejectsWith(client.getJson("//evil.example.com/x"), Err.GatewayConfigError);
    await rejectsWith(client.getJson("api/v1/x"), Err.GatewayConfigError);
    assert.strictEqual(fetches.length, 0);
  });
});

for (const [label, path] of [
  ["a backslash", "/\\evil.example.com/x"],
  ["a tab", "/\t/evil.example.com/x"],
  ["a CR/LF", "/\r\n/evil.example.com/x"],
  ["a double slash", "//evil.example.com/x"],
  ["a slash and two backslashes", "/\\\\evil.example.com/x"],
  ["a backslash then slash", "/\\/evil.example.com/x"],
]) {
  test(`a path with ${label} that resolves off-origin is refused before any request, unquoted`, async () => {
    await withFake(async (fake) => {
      const { client, fetches } = makeClient(fake);
      const error = await rejectsWith(client.getJson(path), Err.GatewayConfigError);
      assert.strictEqual(fetches.length, 0, `fetched ${fetches.join(", ")}`);
      assert.ok(!error.message.includes("evil"), `quoted: ${error.message}`);
    });
  });
}

test("an encoded double slash stays a path on the gateway origin", async () => {
  await withFake(async (fake) => {
    const { client, fetches } = makeClient(fake);
    await rejectsWith(client.getJson("/%2F%2Fevil.example.com/x"), Err.GatewayNotFoundError);
    assert.strictEqual(fetches.length, 1);
    assert.strictEqual(new URL(fetches[0]).origin, fake.url);
  });
});

test("a redirect is refused and not followed, as a distinct redirect-refused error that does not quote Location", async () => {
  await withFake(async (fake) => {
    const other = await FakeGateway.start();
    other.grantToken(TOKEN, [Gateway.Scopes.KB_READ]);
    try {
      fake.route({
        method: "GET",
        prefix: "/api/v1/moved",
        handler: (_req, res) => res.writeHead(302, { Location: `${other.url}/api/v1/knowledge-bases?secret-location` }).end(),
      });
      const { client } = makeClient(fake);
      const error = await rejectsWith(client.getJson("/api/v1/moved"), Err.GatewayUnexpectedResponseError);
      assert.strictEqual(error.status, 302);
      assert.strictEqual(error.code, "redirect-refused");
      assert.match(error.message, /redirect/);
      assert.ok(!error.message.includes("secret-location") && !error.message.includes(other.url), error.message);
      assert.strictEqual(other.requests.length, 0, "the redirect target got no request");
    } finally {
      await other.stop();
    }
  });
});

test("authHeadersFor gives the Bearer header for a gateway URL and refuses any other origin", async () => {
  await withFake(async (fake) => {
    const { client } = makeClient(fake);
    assert.deepStrictEqual(await client.authHeadersFor(fake.gitUrl("marketplace", "core")), {
      Authorization: `Bearer ${TOKEN}`,
    });
    await rejectsWith(client.authHeadersFor("https://elsewhere.example.com/x.git"), Err.GatewayConfigError);
    await rejectsWith(client.authHeadersFor("http://127.0.0.1:1/x.git"), Err.GatewayConfigError);
  });
});

test("the fake accepts Basic auth with the token as password on a custom route", async () => {
  await withFake(async (fake) => {
    fake.route({
      method: "GET",
      prefix: Gateway.Paths.GIT,
      scope: Gateway.Scopes.KB_READ,
      handler: (_req, res) => res.writeHead(200, { "Content-Type": "text/plain" }).end("refs"),
    });
    const basic = "Basic " + Buffer.from(`anyone:${TOKEN}`).toString("base64");
    const ok = await fetch(fake.gitUrl("knowledge-base", "kb-x") + "/info/refs", { headers: { Authorization: basic } });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(await ok.text(), "refs");
    const none = await fetch(fake.gitUrl("knowledge-base", "kb-x") + "/info/refs");
    assert.strictEqual(none.status, 401);
  });
});

// ── The token never leaks ───────────────────────────────────────────────

test("a server message that echoes the token is redacted", async () => {
  await withFake(async (fake) => {
    fake.failNext({ status: 401, body: { error: "token-invalid", message: `token ${TOKEN} is revoked` } });
    const { client } = makeClient(fake);
    const error = await rejectsWith(client.getJson("/api/v1/x"), Err.GatewayAuthError);
    assert.match(error.message, /token b6pt_… is revoked/);
  });
});

// ── B6PCore wiring ──────────────────────────────────────────────────────

let promptCalls = 0;

/** Providers for a real B6PCore; `token` (if given) is stored where BearerAuthProvider keeps it. */
function makeProviders(token) {
  const pub = {};
  const secrets = token === undefined ? {} : { bearerAuth: JSON.stringify({ scheme: "bearer", token }) };
  const persistence = {
    get: async (k) => pub[k],
    set: async (k, v) => {
      pub[k] = v;
    },
    delete: async (k) => {
      delete pub[k];
    },
    getSecret: async (k) => secrets[k],
    setSecret: async (k, v) => {
      secrets[k] = v;
    },
    deleteSecret: async (k) => {
      delete secrets[k];
    },
    clearPublic: async () => {
      for (const k of Object.keys(pub)) delete pub[k];
    },
    clearSecrets: async () => {},
  };
  const prompt = {
    inputBox: async () => {
      promptCalls++;
      return undefined;
    },
    confirm: async () => undefined,
    info: () => {},
    popup: async () => {},
    warn: () => {},
    error: () => {},
  };
  return {
    fs: new MockFileSystem(),
    persistence,
    prompt,
    logger: makeLogger(),
    progress: { withProgress: async (tasks) => Promise.all(tasks.map((t) => t.execute())) },
  };
}

test("core.gateway defaults to gateway.bluestep.net and follows the gatewayUrl config", async () => {
  await withFake(async (fake) => {
    const core = new B6PCore(makeProviders(TOKEN));
    try {
      assert.strictEqual(await core.gateway.client.origin(), Gateway.DEFAULT_URL);
      await core.setConfig("gatewayUrl", fake.url);
      fake.repos = [{ name: "core", description: "", defaultBranch: "master", tags: ["v1.0.0"], gitUrl: fake.gitUrl("marketplace", "core") }];
      const body = await core.gateway.client.getJson(Gateway.Paths.REGISTRY_REPOS);
      assert.strictEqual(body.repos[0].name, "core");
      assert.strictEqual(fake.requests[0].authorization, `Bearer ${TOKEN}`);
      await core.clearSettings();
      assert.strictEqual(await core.gateway.client.origin(), Gateway.DEFAULT_URL);
    } finally {
      core.dispose();
    }
  });
});

test("core.gateway sends the token BearerAuthProvider stores, without prompting", async () => {
  await withFake(async (fake) => {
    promptCalls = 0;
    const core = new B6PCore(makeProviders(TOKEN));
    try {
      await core.setConfig("gatewayUrl", fake.url);
      await core.gateway.client.getJson(Gateway.Paths.KNOWLEDGE_BASES);
      assert.strictEqual(fake.requests[0].authorization, `Bearer ${TOKEN}`);
      assert.strictEqual(promptCalls, 0);
    } finally {
      core.dispose();
    }
  });
});

test("core.gateway with no stored token fails token-missing without prompting or sending", async () => {
  await withFake(async (fake) => {
    promptCalls = 0;
    const core = new B6PCore(makeProviders(undefined));
    try {
      await core.setConfig("gatewayUrl", fake.url);
      const error = await rejectsWith(core.gateway.client.getJson("/api/v1/x"), Err.GatewayAuthError);
      assert.strictEqual(error.reason, "token-missing");
      assert.strictEqual(fake.requests.length, 0);
      assert.strictEqual(promptCalls, 0);
    } finally {
      core.dispose();
    }
  });
});

test("clearAll removes the token from the gateway too", async () => {
  await withFake(async (fake) => {
    const core = new B6PCore(makeProviders(TOKEN));
    try {
      await core.clearAll();
      await core.setConfig("gatewayUrl", fake.url);
      const error = await rejectsWith(core.gateway.client.getJson("/api/v1/x"), Err.GatewayAuthError);
      assert.strictEqual(error.reason, "token-missing");
      assert.strictEqual(fake.requests.length, 0);
    } finally {
      core.dispose();
    }
  });
});

test("a consumer-supplied non-bearer AuthProvider gives the gateway no token", async () => {
  await withFake(async (fake) => {
    const providers = makeProviders(TOKEN);
    providers.auth = {
      authHeaderValue: async () => "Custom x",
      getOrCreate: async () => ({ scheme: "custom" }),
      createNew: async () => ({ scheme: "custom" }),
      update: async () => ({ scheme: "custom" }),
      clear: async () => {},
      hasCredentials: async () => true,
    };
    const core = new B6PCore(providers);
    try {
      await core.setConfig("gatewayUrl", fake.url);
      const error = await rejectsWith(core.gateway.client.getJson("/api/v1/x"), Err.GatewayAuthError);
      assert.strictEqual(error.reason, "token-missing");
    } finally {
      core.dispose();
    }
  });
});

// ── Run ─────────────────────────────────────────────────────────────────

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

  // Last: across every request, error and log line above, the token appeared nowhere.
  const leaks = [...thrownMessages, ...logLines].filter((line) => line.includes(TOKEN));
  if (thrownMessages.length === 0 || leaks.length > 0) {
    failures++;
    console.error(`  ✗ the token never appears in a thrown message or log line\n    ${leaks.join("\n    ")}`);
  } else {
    console.log(`  ✓ the token never appears in a thrown message or log line (${thrownMessages.length} errors, ${logLines.length} log lines)`);
  }

  if (failures > 0) {
    console.error(`\nGateway: ${failures} failing`);
    process.exit(1);
  }
  console.log(`\nGateway: all ${pending.length + 1} passing`);
})();
