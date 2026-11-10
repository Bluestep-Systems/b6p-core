// Behavioral spec for `core.gateway.tokens`: self-service management of the caller's own gateway
// access tokens (list / create / revoke / rotate), per the gateway contract's §Tokens.
//
// What it pins: an id-or-alias resolves through list() to exactly one of the caller's tokens (none →
// GatewayNotFoundError, two → GatewayTokenAmbiguousError, nothing sent); rotating the stored token
// stores its replacement (still ONE stored token); a store failure after a successful rotate throws
// GatewayTokenStoreError carrying the new secret, non-enumerably; revoking the stored token reports
// revokedCurrent and leaves it stored; `scope-escalation` and `alias-taken` map to their own errors;
// a null expiry round-trips as `neverExpires`; and no secret ever reaches a log line or an error
// message.
//
// Dependency-free node script (run via `npm test`). Exercises the COMPILED output in dist/ against
// FakeGateway on 127.0.0.1 (an ephemeral port). No file paths, so it runs the same on Windows and POSIX.

const assert = require("node:assert");
const util = require("node:util");
const {
  B6PCore,
  BearerAuthProvider,
  Err,
  FakeGateway,
  Gateway,
  GatewayClient,
  GatewayService,
  GatewayTokenService,
  MockFileSystem,
  gatewayErrorFor,
} = require("../dist/index.js");

const TOKEN = "b6pt_tokens_spec_0123456789abcdef";
const ALL_SCOPES = [Gateway.Scopes.TOKENS_SELF, Gateway.Scopes.KB_READ, Gateway.Scopes.KB_PUSH];
const DAY_MS = 24 * 60 * 60 * 1_000;

let failures = 0;
const pending = [];
function test(name, fn) {
  pending.push([name, fn]);
}

/** Every line any logger in this file was asked to write. */
const logLines = [];
/** Every caught error, rendered as message, `util.inspect` and `JSON.stringify`, for the leak check. */
const thrownRenderings = [];
/** Every secret this file saw (stored, granted or minted), none of which may leak. */
const secrets = new Set([TOKEN]);

function makeLogger() {
  const log = (...args) => logLines.push(args.map(String).join(" "));
  return { info: log, warn: log, error: log, debug: log };
}

function record(error) {
  thrownRenderings.push(error.message, util.inspect(error), JSON.stringify(error));
}

/** Await `promise`, require it to reject with `type`, record its renderings, and return the error. */
async function rejectsWith(promise, type) {
  try {
    await promise;
  } catch (error) {
    record(error);
    assert.ok(error instanceof type, `expected ${type.name}, got ${error && error.name}: ${error && error.message}`);
    assert.ok(error instanceof Err.GatewayError, "every gateway error extends Err.GatewayError");
    return error;
  }
  assert.fail(`expected ${type.name}, but it resolved`);
}

let promptCalls = 0;

/** Providers for a real B6PCore with `token` stored where BearerAuthProvider keeps it. */
function makeProviders(token, options = {}) {
  const pub = {};
  const store = token === undefined ? {} : { bearerAuth: JSON.stringify({ scheme: "bearer", token }) };
  const state = { failSetSecret: false, setSecretDelayMs: 0, foreignOverwrite: false };
  const persistence = {
    get: async (k) => pub[k],
    set: async (k, v) => {
      pub[k] = v;
    },
    delete: async (k) => {
      delete pub[k];
    },
    getSecret: async (k) => store[k],
    setSecret: async (k, v) => {
      if (state.setSecretDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, state.setSecretDelayMs));
      }
      if (state.failSetSecret) {
        throw new Error("secret storage is unavailable");
      }
      const before = store[k];
      store[k] = v;
      if (state.foreignOverwrite && k === "bearerAuth") {
        // Another process (the CLI beside the extension) writes the old blob back right after.
        store[k] = before;
      }
    },
    deleteSecret: async (k) => {
      delete store[k];
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
    state,
    storedToken: () => (store.bearerAuth ? JSON.parse(store.bearerAuth).token : undefined),
    providers: {
      fs: new MockFileSystem(),
      persistence,
      prompt,
      logger: makeLogger(),
      progress: { withProgress: async (tasks) => Promise.all(tasks.map((t) => t.execute())) },
      ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
    },
  };
}

/**
 * A fake gateway with TOKEN granted (alias "laptop", id "tok_laptop") and a B6PCore storing it.
 * `fn(fake, core, env)`.
 */
async function withCore(fn, scopes = ALL_SCOPES, tokenOptions = {}, coreOptions = {}) {
  const fake = await FakeGateway.start();
  fake.grantToken(TOKEN, scopes, { id: "tok_laptop", alias: "laptop", ...tokenOptions });
  const env = makeProviders(TOKEN, coreOptions);
  const core = new B6PCore(env.providers);
  promptCalls = 0;
  try {
    await core.setConfig("gatewayUrl", fake.url);
    await fn(fake, core, env);
    assert.strictEqual(promptCalls, 0, "token management never prompts");
  } finally {
    // Every secret the fake ever accepted (granted or minted, revoked ones included).
    for (const secret of fake.issuedSecrets) secrets.add(secret);
    core.dispose();
    await fake.stop();
  }
}

const tokenRequests = (fake) => fake.requests.filter((r) => r.path.startsWith(Gateway.Paths.TOKENS));

// ── list ────────────────────────────────────────────────────────────────

test("list returns the caller's own tokens, marks the stored one current, and never another user's", async () => {
  await withCore(async (fake, core) => {
    fake.grantToken("b6pt_other_ci", [Gateway.Scopes.KB_READ], { id: "tok_ci", alias: "ci", expiresAt: null });
    fake.grantToken("b6pt_someone_else", ALL_SCOPES, { id: "tok_x", alias: "x", owner: "someone-else" });
    const tokens = await core.gateway.tokens.list();
    assert.deepStrictEqual(
      tokens.map((t) => [t.id, t.alias, t.current, t.neverExpires]),
      [
        ["tok_laptop", "laptop", true, false],
        ["tok_ci", "ci", false, true],
      ]
    );
    assert.deepStrictEqual(tokens[1].scopes, [Gateway.Scopes.KB_READ]);
    assert.strictEqual(tokens[1].expiresAt, null);
    assert.strictEqual(typeof tokens[0].createdAt, "string");
    assert.strictEqual(fake.requests[0].authorization, `Bearer ${TOKEN}`);
    for (const t of tokens) assert.ok(!("token" in t), "a listed token carries no secret");
  });
});

test("without tokens:self, list fails GatewayScopeError naming tokens:self", async () => {
  await withCore(
    async (_fake, core) => {
      const error = await rejectsWith(core.gateway.tokens.list(), Err.GatewayScopeError);
      assert.strictEqual(error.scope, Gateway.Scopes.TOKENS_SELF);
    },
    [Gateway.Scopes.KB_READ]
  );
});

test("a list answer not shaped like the contract → GatewayUnexpectedResponseError", async () => {
  await withCore(async (fake, core) => {
    fake.failNext({ status: 200, body: { tokens: [{ id: "tok_1" }] } });
    await rejectsWith(core.gateway.tokens.list(), Err.GatewayUnexpectedResponseError);
    fake.failNext({ status: 200, body: { nope: true } });
    await rejectsWith(core.gateway.tokens.list(), Err.GatewayUnexpectedResponseError);
  });
});

test("a numeric id from the gateway is kept as a string", async () => {
  await withCore(async (fake, core) => {
    fake.failNext({
      status: 200,
      body: {
        tokens: [{ id: 42, alias: "n", scopes: [], createdAt: "2026-01-01T00:00:00Z", expiresAt: null, lastUsedAt: null, current: true }],
      },
    });
    const [t] = await core.gateway.tokens.list();
    assert.strictEqual(t.id, "42");
  });
});

// ── create ──────────────────────────────────────────────────────────────

test("create returns the secret once, with the default 90-day expiry when none is given", async () => {
  await withCore(async (fake, core) => {
    const minted = await core.gateway.tokens.create({ alias: "ci", scopes: [Gateway.Scopes.KB_READ] });
    secrets.add(minted.token);
    assert.ok(minted.token.startsWith(Gateway.TOKEN_PREFIX));
    assert.strictEqual(minted.alias, "ci");
    assert.deepStrictEqual(minted.scopes, [Gateway.Scopes.KB_READ]);
    assert.strictEqual(minted.neverExpires, false);
    const days = (Date.parse(minted.expiresAt) - Date.now()) / DAY_MS;
    assert.ok(days > 89 && days <= 90, `expected ~90 days, got ${days}`);
    const post = tokenRequests(fake).find((r) => r.method === "POST");
    assert.deepStrictEqual(JSON.parse(post.body), { alias: "ci", scopes: [Gateway.Scopes.KB_READ] }, "expiresAt left out");
    assert.strictEqual(minted.expiryCapped, null, "a never-expiring presenting token caps nothing");
    assert.ok(fake.issuedTokens().some((t) => t.secret === minted.token), "the fake accepts the minted token");
  }, ALL_SCOPES, { expiresAt: null });
});

test("create with expiresAt: null sends null and round-trips as neverExpires through list and rotate", async () => {
  await withCore(async (fake, core) => {
    const minted = await core.gateway.tokens.create({ alias: "forever", scopes: [Gateway.Scopes.KB_READ], expiresAt: null });
    assert.strictEqual(minted.expiresAt, null);
    assert.strictEqual(minted.neverExpires, true);
    const post = tokenRequests(fake).find((r) => r.method === "POST");
    assert.strictEqual(JSON.parse(post.body).expiresAt, null);
    const listed = (await core.gateway.tokens.list()).find((t) => t.alias === "forever");
    assert.strictEqual(listed.expiresAt, null);
    assert.strictEqual(listed.neverExpires, true);
    const rotated = await core.gateway.tokens.rotate("forever");
    assert.strictEqual(rotated.token.expiresAt, null);
    assert.strictEqual(rotated.token.neverExpires, true);
  }, ALL_SCOPES, { expiresAt: null });
});

test("create with an explicit expiresAt sends it and gets it back", async () => {
  await withCore(async (_fake, core) => {
    const at = "2027-02-01T00:00:00.000Z";
    const minted = await core.gateway.tokens.create({ alias: "dated", scopes: [Gateway.Scopes.KB_READ], expiresAt: at });
    assert.strictEqual(minted.expiresAt, at);
    assert.strictEqual(minted.neverExpires, false);
  });
});

test("create with no expiry mints for the presenting token's expiry when that is under 90 days, and says it was capped", async () => {
  const presentingExpiry = new Date(Date.now() + 10 * DAY_MS).toISOString();
  await withCore(
    async (fake, core) => {
      const minted = await core.gateway.tokens.create({ alias: "capped", scopes: [Gateway.Scopes.KB_READ] });
      secrets.add(minted.token);
      assert.strictEqual(minted.expiresAt, presentingExpiry);
      assert.deepStrictEqual(minted.expiryCapped, { cappedTo: presentingExpiry, requested: "90d" });
      const reqs = tokenRequests(fake);
      assert.deepStrictEqual(
        reqs.map((r) => r.method),
        ["GET", "POST"],
        "the caller's tokens are read, then the mint"
      );
      assert.strictEqual(JSON.parse(reqs[1].body).expiresAt, presentingExpiry);
    },
    ALL_SCOPES,
    { expiresAt: presentingExpiry }
  );
});

test("create with no expiry and a presenting token past 90 days sends no expiry and reports no cap", async () => {
  const far = new Date(Date.now() + 200 * DAY_MS).toISOString();
  await withCore(
    async (fake, core) => {
      const minted = await core.gateway.tokens.create({ alias: "uncapped", scopes: [Gateway.Scopes.KB_READ] });
      secrets.add(minted.token);
      assert.strictEqual(minted.expiryCapped, null);
      assert.ok(!("expiresAt" in JSON.parse(tokenRequests(fake).find((r) => r.method === "POST").body)));
    },
    ALL_SCOPES,
    { expiresAt: far }
  );
});

test("create with an explicit expiry or never is sent as asked, never capped", async () => {
  const soon = new Date(Date.now() + 10 * DAY_MS).toISOString();
  const within = new Date(Date.now() + 5 * DAY_MS).toISOString();
  await withCore(
    async (fake, core) => {
      const minted = await core.gateway.tokens.create({ alias: "w", scopes: [Gateway.Scopes.KB_READ], expiresAt: within });
      secrets.add(minted.token);
      assert.strictEqual(minted.expiresAt, within);
      assert.strictEqual(minted.expiryCapped, null);
      const posts = tokenRequests(fake).filter((r) => r.method === "POST");
      assert.strictEqual(JSON.parse(posts[0].body).expiresAt, within);
    },
    ALL_SCOPES,
    { expiresAt: soon }
  );
});

test("403 not-permitted on a mint outliving the presenting token → GatewayTokenExpiryRefusedError with both expiries", async () => {
  const presentingExpiry = new Date(Date.now() + 10 * DAY_MS).toISOString();
  const later = new Date(Date.now() + 40 * DAY_MS).toISOString();
  await withCore(
    async (_fake, core) => {
      const error = await rejectsWith(
        core.gateway.tokens.create({ alias: "long", scopes: [Gateway.Scopes.KB_READ], expiresAt: later }),
        Err.GatewayTokenExpiryRefusedError
      );
      assert.ok(error instanceof Err.GatewayNotPermittedError);
      assert.strictEqual(error.status, 403);
      assert.strictEqual(error.code, "not-permitted");
      assert.strictEqual(error.requestedExpiresAt, later);
      assert.strictEqual(error.presentingExpiresAt, presentingExpiry);
      const never = await rejectsWith(
        core.gateway.tokens.create({ alias: "never", scopes: [Gateway.Scopes.KB_READ], expiresAt: null }),
        Err.GatewayTokenExpiryRefusedError
      );
      assert.strictEqual(never.requestedExpiresAt, null);
      assert.strictEqual(never.presentingExpiresAt, presentingExpiry);
    },
    ALL_SCOPES,
    { expiresAt: presentingExpiry }
  );
});

test("a 403 not-permitted mint that the expiry does not explain stays a plain GatewayNotPermittedError", async () => {
  await withCore(async (fake, core) => {
    fake.failNext({ method: "POST", status: 403, body: { error: "not-permitted", message: "m" } });
    const error = await rejectsWith(
      core.gateway.tokens.create({ alias: "restricted", scopes: [Gateway.Scopes.KB_READ] }),
      Err.GatewayNotPermittedError
    );
    assert.ok(!(error instanceof Err.GatewayTokenExpiryRefusedError));
  });
});

test("409 token-limit on a mint → GatewayTokenLimitError carrying the limit", async () => {
  await withCore(async (fake, core) => {
    for (let n = 0; n < 49; n++) {
      fake.grantToken(`b6pt_filler_${n}`, [Gateway.Scopes.KB_READ], { alias: `filler-${n}`, expiresAt: null });
    }
    const error = await rejectsWith(
      core.gateway.tokens.create({ alias: "one-too-many", scopes: [Gateway.Scopes.KB_READ], expiresAt: null }),
      Err.GatewayTokenLimitError
    );
    assert.strictEqual(error.limit, 50);
    assert.strictEqual(error.status, 409);
  }, ALL_SCOPES, { expiresAt: null });
});

test("kb:rewrite is not refused client-side: it is sent to the gateway on mint and rotate", async () => {
  await withCore(
    async (fake, core) => {
      const minted = await core.gateway.tokens.create({
        alias: "rewriter",
        scopes: [Gateway.Scopes.KB_READ, "kb:rewrite"],
        expiresAt: null,
      });
      secrets.add(minted.token);
      assert.deepStrictEqual(minted.scopes, [Gateway.Scopes.KB_READ, "kb:rewrite"]);
      const rotated = await core.gateway.tokens.rotate("rewriter");
      secrets.add(rotated.token.token);
      assert.ok(rotated.token.scopes.includes("kb:rewrite"));
      // A scope the presenting token lacks is still the server's call (scope-escalation).
      await rejectsWith(
        core.gateway.tokens.create({ alias: "other", scopes: ["kb:rewrite", "mcp"], expiresAt: null }),
        Err.GatewayScopeEscalationError
      );
      assert.ok(fake.requests.length > 0);
    },
    [...ALL_SCOPES, "kb:rewrite"],
    { expiresAt: null }
  );
});

test("list derives expired, accepts a null createdAt, and keeps expired tokens", async () => {
  await withCore(async (fake, core) => {
    fake.grantToken("b6pt_old_expired", [Gateway.Scopes.KB_READ], {
      id: "tok_old",
      alias: "old",
      createdAt: null,
      expiresAt: new Date(Date.now() - DAY_MS).toISOString(),
    });
    const tokens = await core.gateway.tokens.list();
    const old = tokens.find((t) => t.alias === "old");
    assert.strictEqual(old.createdAt, null);
    assert.strictEqual(old.expired, true);
    assert.strictEqual(old.neverExpires, false);
    assert.strictEqual(tokens.find((t) => t.current).expired, false);
    // A listing that leaves createdAt out altogether reads as null too.
    fake.failNext({
      status: 200,
      body: JSON.stringify({ tokens: [{ id: "t1", alias: "a", scopes: [], expiresAt: null, lastUsedAt: null, current: true }] }),
    });
    const [only] = await core.gateway.tokens.list();
    assert.strictEqual(only.createdAt, null);
    assert.strictEqual(only.expired, false);
  });
});

test("rotating an expired token or one with unknown createdAt is allowed (90 days)", async () => {
  await withCore(async (fake, core) => {
    fake.grantToken("b6pt_unknown_created", [Gateway.Scopes.KB_READ], {
      id: "tok_u",
      alias: "unknown",
      createdAt: null,
      expiresAt: new Date(Date.now() + 5 * DAY_MS).toISOString(),
    });
    const rotated = await core.gateway.tokens.rotate("unknown");
    secrets.add(rotated.token.token);
    const days = (Date.parse(rotated.token.expiresAt) - Date.now()) / DAY_MS;
    assert.ok(days > 89 && days <= 90, `expected ~90 days, got ${days}`);
  });
});

test("403 scope-escalation → GatewayScopeEscalationError, not a scope-missing or not-permitted error", async () => {
  await withCore(async (_fake, core) => {
    const error = await rejectsWith(
      core.gateway.tokens.create({ alias: "big", scopes: [Gateway.Scopes.REGISTRY_PUSH] }),
      Err.GatewayScopeEscalationError
    );
    assert.strictEqual(error.status, 403);
    assert.strictEqual(error.code, "scope-escalation");
    assert.ok(!(error instanceof Err.GatewayScopeError));
    assert.ok(!(error instanceof Err.GatewayNotPermittedError));
  });
});

test("409 alias-taken → GatewayAliasTakenError, not the non-fast-forward GatewayConflictError", async () => {
  await withCore(async (_fake, core) => {
    const error = await rejectsWith(
      core.gateway.tokens.create({ alias: "laptop", scopes: [Gateway.Scopes.KB_READ] }),
      Err.GatewayAliasTakenError
    );
    assert.strictEqual(error.status, 409);
    assert.strictEqual(error.code, "alias-taken");
    assert.ok(!(error instanceof Err.GatewayConflictError));
  });
});

test("gatewayErrorFor maps the two new codes and leaves non-fast-forward and other 403s as they were", () => {
  const body = (error) => JSON.stringify({ error, message: "m" });
  assert.ok(gatewayErrorFor(403, body("scope-escalation"), "x") instanceof Err.GatewayScopeEscalationError);
  assert.ok(gatewayErrorFor(409, body("alias-taken"), "x") instanceof Err.GatewayAliasTakenError);
  assert.ok(gatewayErrorFor(409, body("non-fast-forward"), "x") instanceof Err.GatewayConflictError);
  assert.ok(gatewayErrorFor(409, "", "x") instanceof Err.GatewayConflictError);
  assert.ok(gatewayErrorFor(403, body("not-permitted"), "x") instanceof Err.GatewayNotPermittedError);
  const scope = gatewayErrorFor(403, JSON.stringify({ error: "scope-missing", scope: "tokens:self" }), "x");
  assert.ok(scope instanceof Err.GatewayScopeError);
  assert.strictEqual(scope.scope, "tokens:self");
});

test("create refuses a bad alias, scope list or expiry before sending anything", async () => {
  await withCore(async (fake, core) => {
    const cases = [
      { alias: "", scopes: [Gateway.Scopes.KB_READ] },
      { alias: "has space", scopes: [Gateway.Scopes.KB_READ] },
      { alias: `${TOKEN}`, scopes: [Gateway.Scopes.KB_READ] },
      { alias: "ok", scopes: [] },
      { alias: "ok", scopes: [""] },
      { alias: "ok", scopes: [Gateway.Scopes.KB_READ], expiresAt: "next tuesday" },
      { alias: "ok", scopes: [Gateway.Scopes.KB_READ], expiresAt: "March 7" },
      { alias: "ok", scopes: [Gateway.Scopes.KB_READ], expiresAt: "1" },
      { alias: "ok", scopes: [Gateway.Scopes.KB_READ], expiresAt: "2026-13-01T00:00:00Z" },
      { alias: "ok", scopes: [Gateway.Scopes.KB_READ], expiresAt: "2026-02-30T00:00:00Z" },
      { alias: "ok", scopes: [Gateway.Scopes.KB_READ], expiresAt: "2026-12-01T00:00:00" },
      { alias: "ok", scopes: [Gateway.Scopes.KB_READ], expiresAt: "2026-12-01" },
    ];
    for (const request of cases) {
      await rejectsWith(core.gateway.tokens.create(request), Err.GatewayInvalidArgumentError);
    }
    assert.strictEqual(fake.requests.length, 0);
  });
});

test("a malformed mint answer carrying a secret → GatewayOffContractTokenError that keeps it but never quotes it", async () => {
  await withCore(async (fake, core) => {
    const leaked = "b6pt_in_a_malformed_body_0001";
    secrets.add(leaked);
    fake.failNext({ method: "POST", status: 201, body: JSON.stringify({ id: "tok_9", token: leaked }) });
    const error = await rejectsWith(
      core.gateway.tokens.create({ alias: "ci", scopes: [Gateway.Scopes.KB_READ] }),
      Err.GatewayOffContractTokenError
    );
    assert.strictEqual(error.secret, leaked);
  });
});

test("a mint answer with no secret at all → GatewayUnexpectedResponseError", async () => {
  await withCore(async (fake, core) => {
    fake.failNext({ method: "POST", status: 201, body: JSON.stringify({ id: "tok_9", alias: "ci" }) });
    await rejectsWith(
      core.gateway.tokens.create({ alias: "ci", scopes: [Gateway.Scopes.KB_READ] }),
      Err.GatewayUnexpectedResponseError
    );
  });
});

// ── alias resolution ────────────────────────────────────────────────────

test("an id or alias resolves to exactly one token; none → GatewayNotFoundError, nothing revoked", async () => {
  await withCore(async (fake, core) => {
    fake.grantToken("b6pt_someone_else", ALL_SCOPES, { id: "tok_x", alias: "theirs", owner: "someone-else" });
    for (const missing of ["nope", "theirs", "tok_x"]) {
      await rejectsWith(core.gateway.tokens.revoke(missing), Err.GatewayNotFoundError);
      await rejectsWith(core.gateway.tokens.rotate(missing), Err.GatewayNotFoundError);
    }
    assert.ok(tokenRequests(fake).every((r) => r.method === "GET"), "only list() was sent");
    assert.strictEqual(fake.issuedTokens().length, 2);
  });
});

test("an id matching one token and an alias matching another → GatewayTokenAmbiguousError, nothing sent", async () => {
  await withCore(async (fake, core) => {
    fake.grantToken("b6pt_one", [Gateway.Scopes.KB_READ], { id: "dup", alias: "first" });
    fake.grantToken("b6pt_two", [Gateway.Scopes.KB_READ], { id: "tok_2", alias: "dup" });
    const error = await rejectsWith(core.gateway.tokens.revoke("dup"), Err.GatewayTokenAmbiguousError);
    assert.deepStrictEqual([...error.ids].sort(), ["dup", "tok_2"]);
    assert.ok(tokenRequests(fake).every((r) => r.method === "GET"));
  });
});

test("a token secret given as the id or alias is refused unsent and unquoted", async () => {
  await withCore(async (fake, core) => {
    await rejectsWith(core.gateway.tokens.revoke(TOKEN), Err.GatewayInvalidArgumentError);
    await rejectsWith(core.gateway.tokens.rotate(TOKEN), Err.GatewayInvalidArgumentError);
    await rejectsWith(core.gateway.tokens.revoke(""), Err.GatewayInvalidArgumentError);
    assert.strictEqual(fake.requests.length, 0);
  });
});

// ── revoke ──────────────────────────────────────────────────────────────

test("revoke by alias or by id deletes that token by id", async () => {
  await withCore(async (fake, core) => {
    fake.grantToken("b6pt_ci", [Gateway.Scopes.KB_READ], { id: "tok/ci", alias: "ci" });
    fake.grantToken("b6pt_old", [Gateway.Scopes.KB_READ], { id: "tok_old", alias: "old" });
    const byAlias = await core.gateway.tokens.revoke("ci");
    assert.deepStrictEqual(byAlias, { id: "tok/ci", alias: "ci", revokedCurrent: false });
    const byId = await core.gateway.tokens.revoke("tok_old");
    assert.deepStrictEqual(byId, { id: "tok_old", alias: "old", revokedCurrent: false });
    const deletes = tokenRequests(fake).filter((r) => r.method === "DELETE").map((r) => r.path);
    assert.deepStrictEqual(deletes, [`${Gateway.Paths.TOKENS}/tok%2Fci`, `${Gateway.Paths.TOKENS}/tok_old`]);
    assert.deepStrictEqual(fake.issuedTokens().map((t) => t.alias), ["laptop"]);
  });
});

test("revoking the stored token is allowed, reports revokedCurrent, and leaves the stored token in place", async () => {
  await withCore(async (fake, core, env) => {
    const result = await core.gateway.tokens.revoke("laptop");
    assert.deepStrictEqual(result, { id: "tok_laptop", alias: "laptop", revokedCurrent: true });
    assert.strictEqual(env.storedToken(), TOKEN, "core does not delete the stored token");
    assert.strictEqual(fake.issuedTokens().length, 0);
    const error = await rejectsWith(core.gateway.tokens.list(), Err.GatewayAuthError);
    assert.strictEqual(error.reason, "token-invalid");
  });
});

// ── rotate ──────────────────────────────────────────────────────────────

test("rotating another token keeps its alias, scopes and lifetime, revokes the old, and leaves the stored token", async () => {
  await withCore(async (fake, core, env) => {
    const createdAt = new Date(Date.now() - 10 * DAY_MS).toISOString();
    const expiresAt = new Date(Date.now() + 20 * DAY_MS).toISOString();
    fake.grantToken("b6pt_ci_old", [Gateway.Scopes.KB_READ], { id: "tok_ci", alias: "ci", createdAt, expiresAt });
    const result = await core.gateway.tokens.rotate("ci");
    assert.deepStrictEqual(result.replaced, { id: "tok_ci", alias: "ci" });
    assert.strictEqual(result.rotatedCurrent, false);
    assert.strictEqual(result.token.alias, "ci");
    assert.deepStrictEqual(result.token.scopes, [Gateway.Scopes.KB_READ]);
    assert.notStrictEqual(result.token.token, "b6pt_ci_old");
    const days = (Date.parse(result.token.expiresAt) - Date.now()) / DAY_MS;
    assert.ok(days > 29 && days <= 30, `same 30-day duration from now, got ${days}`);
    assert.strictEqual(env.storedToken(), TOKEN);
    const secretsNow = fake.issuedTokens().map((t) => t.secret);
    assert.ok(!secretsNow.includes("b6pt_ci_old"), "the old token is revoked");
    assert.ok(secretsNow.includes(result.token.token));
    assert.ok(tokenRequests(fake).some((r) => r.method === "POST" && r.path === `${Gateway.Paths.TOKENS}/tok_ci/rotate`));
  });
});

test("rotating the stored token stores the replacement, and the next request presents it", async () => {
  await withCore(async (fake, core, env) => {
    const result = await core.gateway.tokens.rotate("tok_laptop");
    assert.strictEqual(result.rotatedCurrent, true);
    assert.deepStrictEqual(result.replaced, { id: "tok_laptop", alias: "laptop" });
    assert.strictEqual(env.storedToken(), result.token.token, "the replacement is the stored token");
    const tokens = await core.gateway.tokens.list();
    assert.deepStrictEqual(tokens.map((t) => [t.alias, t.current]), [["laptop", true]]);
    assert.strictEqual(fake.requests.at(-1).authorization, `Bearer ${result.token.token}`);
  });
});

test("a store failure after the stored token rotated throws GatewayTokenStoreError carrying the new secret", async () => {
  await withCore(async (fake, core, env) => {
    env.state.failSetSecret = true;
    const error = await rejectsWith(core.gateway.tokens.rotate("laptop"), Err.GatewayTokenStoreError);
    const replacement = error.replacement;
    secrets.add(replacement.token);
    assert.strictEqual(error.code, "store-failed");
    assert.strictEqual(replacement.alias, "laptop");
    assert.ok(fake.issuedTokens().some((t) => t.secret === replacement.token), "the carried secret is the live token");
    assert.ok(!fake.issuedTokens().some((t) => t.secret === TOKEN), "the old token is revoked");
    assert.strictEqual(env.storedToken(), TOKEN, "the stored value is unchanged");
    assert.ok(!Object.keys(error).includes("replacement"), "the secret is non-enumerable on the error");
    assert.ok(error.message.includes("secret storage is unavailable"), "the message says why");
  });
});

test("the store only replaces the token that was rotated (BearerAuthProvider.replaceStoredToken)", async () => {
  const store = { bearerAuth: JSON.stringify({ scheme: "bearer", token: "b6pt_now_stored" }) };
  const persistence = {
    getSecret: async (k) => store[k],
    setSecret: async (k, v) => {
      store[k] = v;
    },
    deleteSecret: async (k) => {
      delete store[k];
    },
  };
  const auth = new BearerAuthProvider(persistence, {}, makeLogger());
  await assert.rejects(auth.replaceStoredToken("b6pt_was_rotated", "b6pt_next"), (e) => {
    thrownRenderings.push(e.message);
    return !e.message.includes("b6pt_");
  });
  assert.strictEqual(JSON.parse(store.bearerAuth).token, "b6pt_now_stored");
  await assert.rejects(auth.replaceStoredToken("b6pt_now_stored", ""));
  await auth.replaceStoredToken("b6pt_now_stored", "b6pt_next");
  assert.deepStrictEqual(JSON.parse(store.bearerAuth), { scheme: "bearer", token: "b6pt_next" });
});

test("rotate tells the store exactly which token it replaces, and a refusal still carries the secret", async () => {
  const fake = await FakeGateway.start();
  try {
    fake.grantToken(TOKEN, ALL_SCOPES, { id: "tok_laptop", alias: "laptop" });
    const stored = TOKEN;
    const replaced = [];
    const service = new GatewayService({
      fs: new MockFileSystem(),
      sessionManager: null,
      logger: makeLogger(),
      prompt: null,
      progress: null,
      isDebugMode: () => false,
      gatewayToken: { token: async () => stored },
      gatewayTokenStore: {
        replace: async (expected, next) => {
          replaced.push([expected, next]);
          throw new Error("the stored token changed");
        },
      },
      gatewayUrl: async () => fake.url,
      fetchFn: globalThis.fetch.bind(globalThis),
    });
    const error = await rejectsWith(service.tokens.rotate("laptop"), Err.GatewayTokenStoreError);
    secrets.add(error.replacement.token);
    assert.deepStrictEqual(replaced, [[TOKEN, error.replacement.token]], "replace() is told which token it replaces");
  } finally {
    await fake.stop();
  }
});

// ── review-a fixes (ruling 33) ──────────────────────────────────────────

/** A fetch that drops `field` from every 201 token answer, as an off-contract gateway might. */
function dropFromMintAnswers(field) {
  const base = globalThis.fetch.bind(globalThis);
  return async (url, init) => {
    const response = await base(url, init);
    const path = new URL(String(url)).pathname;
    if (response.status !== 201 || !path.startsWith(Gateway.Paths.TOKENS)) {
      return response;
    }
    const body = JSON.parse(await response.text());
    delete body[field];
    return new Response(JSON.stringify(body), { status: 201, headers: { "Content-Type": "application/json" } });
  };
}

test("P0: an off-contract rotate answer of the stored token keeps the secret and still stores it", async () => {
  await withCore(
    async (fake, core, env) => {
      const error = await rejectsWith(core.gateway.tokens.rotate("laptop"), Err.GatewayOffContractTokenError);
      assert.strictEqual(error.operation, "rotate");
      assert.strictEqual(typeof error.secret, "string");
      assert.ok(fake.issuedTokens().some((t) => t.secret === error.secret), "the carried secret is the live token");
      assert.strictEqual(error.stored, true);
      assert.strictEqual(env.storedToken(), error.secret, "the replacement was still stored");
      assert.ok(!Object.keys(error).includes("secret"), "the secret is non-enumerable on the error");
      assert.ok(/rotated/.test(error.message) && /malformed/.test(error.message));
    },
    ALL_SCOPES,
    { expiresAt: null },
    { fetchFn: dropFromMintAnswers("expiresAt") }
  );
});

test("P0: an off-contract rotate answer whose store then fails still carries the secret", async () => {
  await withCore(
    async (fake, core, env) => {
      env.state.failSetSecret = true;
      const error = await rejectsWith(core.gateway.tokens.rotate("laptop"), Err.GatewayOffContractTokenError);
      assert.strictEqual(error.stored, false);
      assert.ok(fake.issuedTokens().some((t) => t.secret === error.secret));
      assert.strictEqual(env.storedToken(), TOKEN);
    },
    ALL_SCOPES,
    {},
    { fetchFn: dropFromMintAnswers("alias") }
  );
});

test("P0: an off-contract create answer keeps the minted secret", async () => {
  await withCore(
    async (fake, core, env) => {
      const error = await rejectsWith(
        core.gateway.tokens.create({ alias: "ci", scopes: [Gateway.Scopes.KB_READ] }),
        Err.GatewayOffContractTokenError
      );
      assert.strictEqual(error.operation, "create");
      assert.strictEqual(error.stored, false);
      assert.ok(fake.issuedTokens().some((t) => t.secret === error.secret && t.alias === "ci"));
      assert.strictEqual(env.storedToken(), TOKEN, "create never stores");
      assert.ok(/minted/.test(error.message) && /malformed/.test(error.message));
    },
    ALL_SCOPES,
    {},
    { fetchFn: dropFromMintAnswers("scopes") }
  );
});

test("P1: a request queued while the stored token's rotate is in flight runs after the store, with the new token", async () => {
  await withCore(async (fake, core, env) => {
    fake.delayMs = 50;
    env.state.setSecretDelayMs = 20;
    const rotating = core.gateway.tokens.rotate("laptop");
    while (!fake.requests.some((r) => r.method === "POST" && r.path.endsWith("/rotate"))) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const queued = core.gateway.client.getJson(Gateway.Paths.KNOWLEDGE_BASES);
    const result = await rotating;
    await queued;
    assert.strictEqual(fake.requests.at(-1).path, Gateway.Paths.KNOWLEDGE_BASES);
    assert.strictEqual(fake.requests.at(-1).authorization, `Bearer ${result.token.token}`);
  });
});

test("P2: a pasted secret with whitespace or quotes around it is refused unsent", async () => {
  await withCore(async (fake, core) => {
    for (const pasted of [` ${TOKEN}`, `"${TOKEN}"`, `'${TOKEN}'\n`, `x${TOKEN}`]) {
      await rejectsWith(core.gateway.tokens.revoke(pasted), Err.GatewayInvalidArgumentError);
      await rejectsWith(core.gateway.tokens.rotate(pasted), Err.GatewayInvalidArgumentError);
    }
    assert.strictEqual(fake.requests.length, 0);
  });
});

test("P2: not-found and ambiguous messages never quote the given id or alias", async () => {
  await withCore(async (fake, core) => {
    fake.grantToken("b6pt_one_p2", [Gateway.Scopes.KB_READ], { id: "dup-p2", alias: "first" });
    fake.grantToken("b6pt_two_p2", [Gateway.Scopes.KB_READ], { id: "tok_2", alias: "dup-p2" });
    const missing = await rejectsWith(core.gateway.tokens.revoke("unmatched-input-xyz"), Err.GatewayNotFoundError);
    assert.ok(!missing.message.includes("unmatched-input-xyz"), missing.message);
    const ambiguous = await rejectsWith(core.gateway.tokens.rotate("dup-p2"), Err.GatewayTokenAmbiguousError);
    assert.ok(!ambiguous.message.includes('"dup-p2"'), ambiguous.message);
  });
});

test("P2: rotate reads the stored token once: list, the rotate POST and the store's expected all use it", async () => {
  const fake = await FakeGateway.start();
  try {
    const other = "b6pt_stored_meanwhile_p2";
    fake.grantToken(TOKEN, ALL_SCOPES, { id: "tok_laptop", alias: "laptop" });
    fake.grantToken(other, ALL_SCOPES, { id: "tok_other", alias: "other" });
    const reads = [TOKEN, other, other, other];
    const replaced = [];
    const service = new GatewayService({
      fs: new MockFileSystem(),
      sessionManager: null,
      logger: makeLogger(),
      prompt: null,
      progress: null,
      isDebugMode: () => false,
      gatewayToken: { token: async () => (reads.length > 1 ? reads.shift() : reads[0]) },
      gatewayTokenStore: {
        replace: async (expected, next) => {
          replaced.push([expected, next]);
        },
      },
      gatewayUrl: async () => fake.url,
      fetchFn: globalThis.fetch.bind(globalThis),
    });
    const result = await service.tokens.rotate("laptop");
    assert.strictEqual(result.rotatedCurrent, true);
    assert.deepStrictEqual(
      fake.requests.map((r) => r.authorization),
      [`Bearer ${TOKEN}`, `Bearer ${TOKEN}`],
      "list and rotate presented the same token"
    );
    assert.deepStrictEqual(replaced, [[TOKEN, result.token.token]]);
  } finally {
    for (const secret of fake.issuedSecrets) secrets.add(secret);
    await fake.stop();
  }
});

test("P3: the fake honours expiresAt: an expired token is 401 token-invalid", async () => {
  await withCore(
    async (_fake, core) => {
      const error = await rejectsWith(core.gateway.tokens.list(), Err.GatewayAuthError);
      assert.strictEqual(error.reason, "token-invalid");
    },
    ALL_SCOPES,
    { createdAt: new Date(Date.now() - 2 * DAY_MS).toISOString(), expiresAt: new Date(Date.now() - DAY_MS).toISOString() }
  );
});

test("P3: the leak sweep knows every secret granted or minted, revoked ones included", async () => {
  await withCore(async (fake, core) => {
    fake.grantToken("b6pt_granted_then_revoked", [Gateway.Scopes.KB_READ], { id: "tok_gr", alias: "gr" });
    await core.gateway.tokens.revoke("gr");
    const minted = await core.gateway.tokens.create({ alias: "m", scopes: [Gateway.Scopes.KB_READ] });
    await core.gateway.tokens.rotate("m");
    assert.ok(fake.issuedSecrets.includes("b6pt_granted_then_revoked"));
    assert.ok(fake.issuedSecrets.includes(minted.token));
    assert.ok(!fake.issuedTokens().some((t) => t.secret === minted.token), "the minted one was rotated away");
  });
});

test("an id that would resolve off-origin is encoded onto the gateway path, so the origin check passes and the token is found", async () => {
  await withCore(async (fake, core) => {
    fake.grantToken("b6pt_hostile_id_0001", [Gateway.Scopes.KB_READ], { id: "\\\\evil.example/x", alias: "hostile" });
    const result = await core.gateway.tokens.revoke("hostile");
    assert.strictEqual(result.id, "\\\\evil.example/x");
    const del = tokenRequests(fake).find((r) => r.method === "DELETE");
    assert.strictEqual(del.path, `${Gateway.Paths.TOKENS}/%5C%5Cevil.example%2Fx`);
    assert.ok(!fake.issuedTokens().some((t) => t.alias === "hostile"));
  });
});

// ── review rev2 fixes ───────────────────────────────────────────────────

test("rev2 P1: a foreign overwrite right after the store's write → GatewayTokenStoreError carrying the replacement", async () => {
  await withCore(async (fake, core, env) => {
    env.state.foreignOverwrite = true;
    const error = await rejectsWith(core.gateway.tokens.rotate("laptop"), Err.GatewayTokenStoreError);
    assert.ok(fake.issuedTokens().some((t) => t.secret === error.replacement.token), "the carried secret is the live token");
    assert.strictEqual(env.storedToken(), TOKEN, "the foreign write won; the store reports it instead of claiming success");
  });
});

test("rev2 P3: create accepts a strict ISO 8601 date-time with Z or an offset", async () => {
  await withCore(async (_fake, core) => {
    for (const at of ["2027-02-01T00:00:00Z", "2027-02-01T00:00:00.123Z", "2027-02-01T08:30:00+05:30", "2027-02-01T00:00Z"]) {
      const minted = await core.gateway.tokens.create({ alias: `a${at.length}${at.slice(-3)}`, scopes: [Gateway.Scopes.KB_READ], expiresAt: at });
      assert.strictEqual(minted.expiresAt, at);
    }
  });
});

/** A token service over a client with a short timeout, and a fetch that misbehaves only on `matches`. */
function serviceWith(fake, matches, misbehave) {
  const base = globalThis.fetch.bind(globalThis);
  const ctx = {
    fs: new MockFileSystem(),
    sessionManager: null,
    logger: makeLogger(),
    prompt: null,
    progress: null,
    isDebugMode: () => false,
    gatewayToken: { token: async () => TOKEN },
    gatewayTokenStore: { replace: async () => {} },
    gatewayUrl: async () => fake.url,
    fetchFn: async (url, init) => {
      if (!matches(init.method, new URL(String(url)).pathname)) {
        return base(url, init);
      }
      return misbehave(base, url, init);
    },
  };
  return new GatewayTokenService(new GatewayClient(ctx, { timeoutMs: 100 }), ctx);
}

/** Send the request for real (the gateway commits), then drop the connection. */
const dropAfterSend = async (base, url, init) => {
  await (await base(url, init)).text();
  throw new TypeError("fetch failed: other side closed");
};

/** Send the request for real, then never answer (until the client's timeout aborts). */
const hangAfterSend = async (base, url, init) => {
  await (await base(url, init)).text();
  return new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
};

const isRotate = (method, path) => method === "POST" && path.endsWith("/rotate");
const isCreate = (method, path) => method === "POST" && path === Gateway.Paths.TOKENS;

for (const [label, misbehave] of [
  ["a dropped connection", dropAfterSend],
  ["a timeout", hangAfterSend],
]) {
  test(`rev2 P2: ${label} on the rotate POST → GatewayOutcomeUnknownError (may have been rotated)`, async () => {
    const fake = await FakeGateway.start();
    try {
      fake.grantToken(TOKEN, ALL_SCOPES, { id: "tok_laptop", alias: "laptop" });
      const error = await rejectsWith(serviceWith(fake, isRotate, misbehave).rotate("laptop"), Err.GatewayOutcomeUnknownError);
      assert.ok(error instanceof Err.GatewayUnavailableError, "still an unavailable error for generic handlers");
      assert.strictEqual(error.operation, "rotate");
      assert.strictEqual(error.code, "outcome-unknown");
      assert.ok(/may have been rotated/.test(error.message) && /revoked/.test(error.message), error.message);
      assert.ok(!fake.issuedTokens().some((t) => t.secret === TOKEN), "the gateway did commit the rotation");
    } finally {
      for (const secret of fake.issuedSecrets) secrets.add(secret);
      await fake.stop();
    }
  });

  test(`rev2 P2: ${label} on the create POST → GatewayOutcomeUnknownError (may have been minted)`, async () => {
    const fake = await FakeGateway.start();
    try {
      fake.grantToken(TOKEN, ALL_SCOPES, { id: "tok_laptop", alias: "laptop" });
      const service = serviceWith(fake, isCreate, misbehave);
      const error = await rejectsWith(
        service.create({ alias: "ci", scopes: [Gateway.Scopes.KB_READ] }),
        Err.GatewayOutcomeUnknownError
      );
      assert.strictEqual(error.operation, "create");
      assert.ok(/may have been minted/.test(error.message), error.message);
    } finally {
      for (const secret of fake.issuedSecrets) secrets.add(secret);
      await fake.stop();
    }
  });
}

test("rev2 P2: a request that never reached the gateway stays a plain GatewayUnavailableError", async () => {
  const fake = await FakeGateway.start();
  try {
    fake.grantToken(TOKEN, ALL_SCOPES, { id: "tok_laptop", alias: "laptop" });
    const service = serviceWith(fake, () => true, async () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    });
    const error = await rejectsWith(service.list(), Err.GatewayUnavailableError);
    assert.ok(!(error instanceof Err.GatewayOutcomeUnknownError));
  } finally {
    await fake.stop();
  }
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

  // Last: across every log line and every error rendering above, no secret appeared.
  const leaks = [...thrownRenderings, ...logLines].filter((line) => [...secrets].some((s) => line.includes(s)));
  if (thrownRenderings.length === 0 || secrets.size < 5 || leaks.length > 0) {
    failures++;
    console.error(`  ✗ no secret appears in a log line or an error\n    ${leaks.join("\n    ")}`);
  } else {
    console.log(
      `  ✓ no secret appears in a log line or an error (${secrets.size} secrets, ${thrownRenderings.length} error renderings, ${logLines.length} log lines)`
    );
  }

  if (failures > 0) {
    console.error(`\nGatewayTokens: ${failures} failing`);
    process.exit(1);
  }
  console.log(`\nGatewayTokens: all ${pending.length + 1} passing`);
})();
