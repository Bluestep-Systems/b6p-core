// Behavioral spec for `B6PCore.schema` (SchemaService): the GraphQL request each method makes, the verbose flag
// (sent only when asked), result decoding including nulls, FORBIDDEN and "server too old" mapping, and testThenApply
// applying the identical manifest string with the key the test minted.
//
// SchemaService reaches the org through `sessionManager.csrfFetch`; the spec supplies a recording stub of it, so no
// login or network is involved. Runs against the COMPILED dist/ (`npm test` compiles first).
const assert = require("node:assert");
const { SchemaService } = require("../dist/schema/SchemaService.js");
const { B6PCore } = require("../dist/B6PCore.js");
const { MockFileSystem } = require("../dist/testing/MockFileSystem.js");
const { Err } = require("../dist/Err.js");

const ORG = "https://myorg.bluestep.net/shared/some/page.jsp?x=1#frag";

/** A SchemaService over a stub session manager answering `answer(body, call)` with a GraphQL body. */
function makeService(answer) {
  const calls = [];
  const warms = [];
  const order = [];
  const sessionManager = {
    async fetch(url) {
      warms.push(String(url));
      order.push("warm");
      return new Response("token");
    },
    async csrfFetch(url, options, retries) {
      const call = { url: String(url), options, retries, body: JSON.parse(options.body) };
      calls.push(call);
      order.push("post");
      const { status = 200, json } = answer(call.body, call);
      return new Response(typeof json === "string" ? json : JSON.stringify(json), { status });
    },
  };
  const noop = () => {};
  const service = new SchemaService({
    fs: new MockFileSystem(),
    sessionManager,
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    prompt: {},
    progress: {},
    isDebugMode: () => false,
  });
  return { service, calls, warms, order };
}

const PASSED = {
  passed: true,
  failedAt: null,
  actions: [
    {
      element: "OptionList us-states",
      action: "CREATE",
      objectId: null,
      spec: '{"name":"us-states"}',
      deltas: [],
      reasons: [],
    },
  ],
  refusals: [],
  schemaMutationKey: "key-1",
  refusal: null,
  warnings: [],
};
const FAILED = {
  passed: false,
  failedAt: "RESOLUTION",
  actions: [],
  refusals: [
    {
      stage: "RESOLUTION",
      code: "AMBIGUOUS_MATCH",
      locus: "document 1",
      detail: "two hits",
      hits: [{ objectId: null, live: "{}" }],
    },
  ],
  schemaMutationKey: null,
  refusal: null,
  warnings: [{ element: "Form f", detail: "same display name" }],
};
const APPLIED = {
  applied: true,
  objects: [{ element: "OptionList us-states", objectId: "530023___9" }],
  refusal: null,
  failedAt: null,
  historyCommit: "abc123",
};

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log("ok   -", name);
  } catch (e) {
    failures++;
    console.error("FAIL -", name, "\n     ", e.stack);
  }
}

(async () => {
  await test("is mounted at core.schema", () => {
    const noop = () => {};
    const persistence = {
      get: async () => undefined,
      set: noop,
      delete: noop,
      getSecret: async () => undefined,
      setSecret: noop,
      deleteSecret: noop,
      clearPublic: noop,
      clearSecrets: noop,
    };
    const core = new B6PCore({
      fs: new MockFileSystem(),
      persistence,
      prompt: {
        error: noop,
        info: noop,
        warn: noop,
        inputBox: noop,
        quickPick: noop,
        showMessage: noop,
        confirm: noop,
      },
      logger: { info: noop, warn: noop, error: noop, debug: noop },
      progress: { report: noop, withProgress: async (_o, t) => t({ report: noop }) },
      orgCacheSettings: { getParsedAnyDomainOverrideUrl: () => new URL("https://myorg.bluestep.net/") },
    });
    assert.ok(core.schema instanceof SchemaService);
    core.dispose();
  });

  await test("generate posts generateSchema to the org's /gql with the server defaults", async () => {
    const { service, calls } = makeService(() => ({ json: { data: { generateSchema: "kind: ManifestSet\n" } } }));
    const manifest = await service.generate(ORG, ["530023___1", "530023___2"]);
    assert.strictEqual(manifest, "kind: ManifestSet\n");
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, "https://myorg.bluestep.net/gql");
    assert.strictEqual(calls[0].options.method, "POST");
    assert.match(calls[0].body.query, /generateSchema\(topIds: \$topIds, closure: \$closure, portable: \$portable\)/);
    assert.deepStrictEqual(calls[0].body.variables, {
      topIds: ["530023___1", "530023___2"],
      closure: true,
      portable: false,
    });
  });

  await test("generate sends closure and portable when given", async () => {
    const { service, calls } = makeService(() => ({ json: { data: { generateSchema: "" } } }));
    await service.generate(ORG, ["1"], { closure: false, portable: true });
    assert.deepStrictEqual(calls[0].body.variables, { topIds: ["1"], closure: false, portable: true });
  });

  await test("recipe posts schemaRecipe and decodes findings with null ids", async () => {
    const result = {
      manifest: "m",
      findings: [
        { code: "EXPLICIT_DENY", severity: "WARNING", subjectId: null, fieldId: "f1", formId: null, detail: "d" },
      ],
    };
    const { service, calls } = makeService(() => ({ json: { data: { schemaRecipe: result } } }));
    const got = await service.recipe(ORG, "LINK_VIEW_GRANTS");
    assert.deepStrictEqual(got, result);
    assert.match(calls[0].body.query, /schemaRecipe\(name: \$name\)/);
    assert.deepStrictEqual(calls[0].body.variables, { name: "LINK_VIEW_GRANTS" });
    for (const field of ["manifest", "findings", "code", "severity", "subjectId", "fieldId", "formId", "detail"]) {
      assert.ok(calls[0].body.query.includes(field), `selects ${field}`);
    }
  });

  await test("test requests every result field and decodes nulls and refusals", async () => {
    const { service, calls } = makeService(() => ({ json: { data: { testSchema: FAILED } } }));
    const got = await service.test(ORG, "manifest text");
    assert.deepStrictEqual(got, FAILED);
    assert.strictEqual(got.schemaMutationKey, null);
    assert.strictEqual(got.refusal, null);
    for (const field of [
      "passed",
      "failedAt",
      "actions",
      "element",
      "action",
      "objectId",
      "spec",
      "deltas",
      "path",
      "kind",
      "from",
      "to",
      "livePositions",
      "reasons",
      "refusals",
      "stage",
      "code",
      "locus",
      "detail",
      "hits",
      "live",
      "schemaMutationKey",
      "refusal",
      "element",
      "warnings",
    ]) {
      assert.ok(calls[0].body.query.includes(field), `selects ${field}`);
    }
    assert.strictEqual(calls[0].body.variables.manifest, "manifest text");
  });

  await test("test does not send verbose unless asked", async () => {
    const { service, calls } = makeService(() => ({ json: { data: { testSchema: PASSED } } }));
    await service.test(ORG, "m");
    await service.test(ORG, "m", {});
    await service.test(ORG, "m", { verbose: false });
    for (const call of calls) {
      assert.ok(!call.body.query.includes("verbose"), "query names no verbose");
      assert.deepStrictEqual(Object.keys(call.body.variables), ["manifest"]);
    }
  });

  await test("test sends verbose: true when asked", async () => {
    const { service, calls } = makeService(() => ({ json: { data: { testSchema: PASSED } } }));
    await service.test(ORG, "m", { verbose: true });
    assert.match(calls[0].body.query, /testSchema\(manifest: \$manifest, verbose: \$verbose\)/);
    assert.deepStrictEqual(calls[0].body.variables, { manifest: "m", verbose: true });
  });

  await test("a server rejecting the verbose argument is a typed 'server too old' error", async () => {
    const { service } = makeService(() => ({
      json: {
        errors: [
          {
            message: "Validation error (UnknownArgument@[testSchema]) : Unknown field argument 'verbose'",
            extensions: { classification: "ValidationError" },
          },
        ],
      },
    }));
    await assert.rejects(service.test(ORG, "m", { verbose: true }), (e) => {
      assert.ok(e instanceof Err.SchemaServerTooOldError);
      assert.match(e.feature, /verbose/);
      return true;
    });
  });

  await test("a server that does not know the operation is 'server too old'", async () => {
    const { service } = makeService(() => ({
      json: {
        errors: [
          {
            message: "Validation error (FieldUndefined@[schemaRecipe]) : Field 'schemaRecipe' undefined",
            extensions: { classification: "ValidationError" },
          },
        ],
      },
    }));
    await assert.rejects(service.recipe(ORG, "LINK_VIEW_GRANTS"), Err.SchemaServerTooOldError);
  });

  await test("an unrelated validation error stays a GraphQLError", async () => {
    const { service } = makeService(() => ({
      json: {
        errors: [
          { message: "Variable 'topIds' has an invalid value", extensions: { classification: "ValidationError" } },
        ],
      },
    }));
    await assert.rejects(service.generate(ORG, ["1"]), Err.GraphQLError);
  });

  await test("FORBIDDEN maps to a typed super-only error on every operation", async () => {
    const forbidden = {
      json: { errors: [{ message: "no", extensions: { code: "FORBIDDEN", classification: "FORBIDDEN" } }], data: null },
    };
    const { service } = makeService(() => forbidden);
    await assert.rejects(
      service.generate(ORG, ["1"]),
      (e) => e instanceof Err.SchemaForbiddenError && /super users/.test(e.message)
    );
    await assert.rejects(service.recipe(ORG, "LINK_VIEW_GRANTS"), Err.SchemaForbiddenError);
    await assert.rejects(service.test(ORG, "m"), Err.SchemaForbiddenError);
    await assert.rejects(service.apply(ORG, "m", "k"), Err.SchemaForbiddenError);
  });

  await test("other GraphQL errors and non-JSON answers use the existing Err classes", async () => {
    const other = makeService(() => ({ json: { errors: [{ message: "boom", extensions: { code: "INTERNAL" } }] } }));
    await assert.rejects(other.service.test(ORG, "m"), Err.GraphQLError);
    const html = makeService(() => ({ status: 502, json: "<html>bad gateway</html>" }));
    await assert.rejects(html.service.test(ORG, "m"), Err.GraphQLFetchError);
    const empty = makeService(() => ({ status: 500, json: {} }));
    await assert.rejects(empty.service.test(ORG, "m"), Err.GraphQLFetchError);
  });

  await test("an answer missing the operation's result is a GraphQLFetchError, never undefined or null", async () => {
    for (const json of [{ data: {} }, { data: { applySchema: null } }, null, { errors: null }, []]) {
      const { service } = makeService(() => ({ json }));
      await assert.rejects(service.apply(ORG, "m", "k"), Err.GraphQLFetchError);
    }
  });

  await test("apply sends the manifest and key as given, decodes the result, and is never retried", async () => {
    const { service, calls } = makeService(() => ({ json: { data: { applySchema: APPLIED } } }));
    const manifest = "a: 1\r\n  b:  2\n\n";
    const got = await service.apply(ORG, manifest, "key-1");
    assert.deepStrictEqual(got, APPLIED);
    assert.match(calls[0].body.query, /applySchema\(manifest: \$manifest, schemaMutationKey: \$key\)/);
    assert.strictEqual(calls[0].body.variables.manifest, manifest);
    assert.strictEqual(calls[0].body.variables.key, "key-1");
    assert.strictEqual(calls[0].retries, 0);
  });

  await test("apply readies the session (one warm fetch) before its single, unretried POST", async () => {
    const { service, calls, warms, order } = makeService(() => ({ json: { data: { applySchema: APPLIED } } }));
    await service.apply(ORG, "m", "k");
    assert.deepStrictEqual(warms, ["https://myorg.bluestep.net/csrf-token"]);
    assert.deepStrictEqual(order, ["warm", "post"]);
    assert.strictEqual(calls.length, 1, "the apply POST is sent once");
  });

  await test("apply decodes a refusal with null element and a null history commit", async () => {
    const refused = {
      applied: false,
      objects: [],
      refusal: { code: "STALE", element: null, detail: "changed" },
      failedAt: null,
      historyCommit: null,
    };
    const { service } = makeService(() => ({ json: { data: { applySchema: refused } } }));
    assert.deepStrictEqual(await service.apply(ORG, "m", "k"), refused);
  });

  await test("testThenApply applies the identical manifest with the key the test minted", async () => {
    const manifest = "kind: ManifestSet\n# a comment\n";
    const { service, calls } = makeService((body) =>
      body.query.includes("testSchema(")
        ? { json: { data: { testSchema: PASSED } } }
        : { json: { data: { applySchema: APPLIED } } }
    );
    let shown = null;
    const got = await service.testThenApply(ORG, manifest, async (r) => ((shown = r), true), { verbose: true });
    assert.deepStrictEqual(shown, PASSED);
    assert.strictEqual(got.declined, false);
    assert.deepStrictEqual(got.apply, APPLIED);
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].body.variables.manifest, manifest);
    assert.strictEqual(calls[0].body.variables.verbose, true);
    assert.strictEqual(calls[1].body.variables.manifest, manifest);
    assert.strictEqual(calls[1].body.variables.key, "key-1");
  });

  await test("testThenApply: a declined confirmation applies nothing", async () => {
    const { service, calls } = makeService(() => ({ json: { data: { testSchema: PASSED } } }));
    const got = await service.testThenApply(ORG, "m", async () => false);
    assert.strictEqual(got.declined, true);
    assert.strictEqual(got.apply, null);
    assert.strictEqual(calls.length, 1);
  });

  await test("testThenApply: a failed test neither asks nor applies", async () => {
    const { service, calls } = makeService(() => ({ json: { data: { testSchema: FAILED } } }));
    let asked = false;
    const got = await service.testThenApply(ORG, "m", async () => ((asked = true), true));
    assert.strictEqual(asked, false);
    assert.strictEqual(got.declined, false);
    assert.strictEqual(got.apply, null);
    assert.deepStrictEqual(got.test, FAILED);
    assert.strictEqual(calls.length, 1);
  });

  if (failures > 0) {
    console.error(`${failures} failure(s)`);
    process.exit(1);
  }
})();
