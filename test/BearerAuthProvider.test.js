// Behavioral spec for `BearerAuthProvider` — the credential lifecycle.
//
// This class replaced `BasicAuthProvider` in 0.5.0 and gained validation the old
// one never had: what comes back out of secret storage is parsed and checked
// rather than asserted, because that store is shared with every other key the
// consumer keeps and its contents outlive any single version of this class.
//
// The bug that motivated the empty-token case: `createNew` rejected only
// `undefined` (the cancel signal), so an empty entry was stored and logged as
// "Token stored" — while `isBearerAuthParams` requires a non-empty token, so
// `hasCredentials()` immediately reported false and the next `authHeaderValue()`
// re-prompted. Pressing Enter on the token box produced an unbounded prompt loop.
//
// Dependency-free node script (run via `npm test`). Exercises the COMPILED
// BearerAuthProvider from dist/.

const assert = require("node:assert");
const { BearerAuthProvider } = require("../dist/auth/BearerAuthProvider.js");

const KEY = "bearerAuth";
const LEGACY_KEY = "basicAuth";

let failures = 0;
const pending = [];
function test(name, fn) {
  pending.push([name, fn]);
}

/** Persistence double exposing only what this provider touches. */
function makePersistence(initialSecrets = {}) {
  const secrets = { ...initialSecrets };
  return {
    secrets,
    persistence: {
      getSecret: async (k) => secrets[k],
      setSecret: async (k, v) => {
        secrets[k] = v;
      },
      deleteSecret: async (k) => {
        delete secrets[k];
      },
      get: async () => undefined,
      set: async () => {},
      delete: async () => {},
      clearPublic: async () => {},
      clearSecrets: async () => {},
    },
  };
}

/** Prompt double that returns a scripted sequence of inputBox answers. */
function makePrompt(answers) {
  const queue = [...answers];
  const messages = [];
  return {
    messages,
    prompt: {
      inputBox: async () => queue.shift(),
      info: (m) => messages.push(["info", m]),
      warn: (m) => messages.push(["warn", m]),
      error: (m) => messages.push(["error", m]),
      popup: async () => {},
      confirm: async () => undefined,
    },
  };
}

const NOOP_LOGGER = { info() {}, warn() {}, error() {}, debug() {} };

function build(secrets, answers) {
  const p = makePersistence(secrets);
  const pr = makePrompt(answers);
  return { p, pr, auth: new BearerAuthProvider(p.persistence, pr.prompt, NOOP_LOGGER) };
}

// ── createNew ───────────────────────────────────────────────────────────

test("createNew stores a token and renders the Bearer header", async () => {
  const { p, auth } = build({}, ["tok-abc"]);
  const creds = await auth.createNew();
  assert.deepStrictEqual(creds, { scheme: "bearer", token: "tok-abc" });
  assert.deepStrictEqual(JSON.parse(p.secrets[KEY]), { scheme: "bearer", token: "tok-abc" });
  assert.strictEqual(await auth.authHeaderValue(), "Bearer tok-abc");
});

test("createNew treats a cancelled prompt as cancellation and stores nothing", async () => {
  const { p, auth } = build({}, [undefined]);
  await assert.rejects(() => auth.createNew(), /cancelled/i);
  assert.strictEqual(p.secrets[KEY], undefined, "nothing may be written on cancel");
});

test("createNew treats an EMPTY token as cancellation and stores nothing", async () => {
  const { p, auth } = build({}, [""]);
  await assert.rejects(() => auth.createNew(), /cancelled/i);
  assert.strictEqual(p.secrets[KEY], undefined, "an empty token must not be stored");
});

test("a token createNew accepts is one hasCredentials agrees with", async () => {
  const { auth } = build({}, ["tok-abc"]);
  await auth.createNew();
  assert.strictEqual(await auth.hasCredentials(), true, "createNew and the validator must agree");
});

// ── readStored / validation ─────────────────────────────────────────────

test("stored credentials that are not valid JSON are treated as absent", async () => {
  const { auth } = build({ [KEY]: "not json {{{" }, ["fresh"]);
  assert.strictEqual(await auth.hasCredentials(), false);
  const creds = await auth.getOrCreate();
  assert.strictEqual(creds.token, "fresh", "a malformed value must route to a fresh prompt");
});

test("stored credentials with the wrong scheme are treated as absent", async () => {
  const { auth } = build({ [KEY]: JSON.stringify({ scheme: "basic", token: "x" }) }, ["fresh"]);
  assert.strictEqual(await auth.hasCredentials(), false);
  assert.strictEqual((await auth.getOrCreate()).token, "fresh");
});

test("stored credentials with an empty token are treated as absent", async () => {
  // This is the shape the pre-fix createNew could write. It must never reach the
  // wire as a literal `Authorization: Bearer `.
  const { auth } = build({ [KEY]: JSON.stringify({ scheme: "bearer", token: "" }) }, ["fresh"]);
  assert.strictEqual(await auth.hasCredentials(), false);
  assert.strictEqual(await auth.authHeaderValue(), "Bearer fresh");
});

test("well-formed stored credentials are returned without prompting", async () => {
  const { auth } = build({ [KEY]: JSON.stringify({ scheme: "bearer", token: "kept" }) }, []);
  assert.strictEqual(await auth.hasCredentials(), true);
  assert.strictEqual((await auth.getOrCreate()).token, "kept", "must not prompt when a token is stored");
});

// ── update ──────────────────────────────────────────────────────────────

test("update replaces the stored token", async () => {
  const { p, auth } = build({ [KEY]: JSON.stringify({ scheme: "bearer", token: "old" }) }, ["new"]);
  const creds = await auth.update();
  assert.strictEqual(creds.token, "new");
  assert.strictEqual(JSON.parse(p.secrets[KEY]).token, "new");
});

test("update with EMPTY input keeps the current token", async () => {
  // Deliberately unlike createNew: here there is a current token to keep.
  const { p, auth } = build({ [KEY]: JSON.stringify({ scheme: "bearer", token: "old" }) }, [""]);
  const creds = await auth.update();
  assert.strictEqual(creds.token, "old");
  assert.strictEqual(JSON.parse(p.secrets[KEY]).token, "old");
});

test("update cancelled leaves the stored token alone", async () => {
  const { p, auth } = build({ [KEY]: JSON.stringify({ scheme: "bearer", token: "old" }) }, [undefined]);
  const creds = await auth.update();
  assert.strictEqual(creds.token, "old");
  assert.strictEqual(JSON.parse(p.secrets[KEY]).token, "old");
});

// ── clear ───────────────────────────────────────────────────────────────

test("clear removes the bearer token AND purges the legacy basicAuth key", async () => {
  // No migration from basic to bearer is possible — a token cannot be derived
  // from a username/password — so clear() is what stops the old credential pair
  // sitting in secret storage forever.
  const { p, auth } = build(
    {
      [KEY]: JSON.stringify({ scheme: "bearer", token: "t" }),
      [LEGACY_KEY]: JSON.stringify({ username: "u", password: "p" }),
      "unrelated:key": "untouched",
    },
    []
  );
  await auth.clear();
  assert.strictEqual(p.secrets[KEY], undefined, "the bearer token must be gone");
  assert.strictEqual(p.secrets[LEGACY_KEY], undefined, "the legacy basic-auth pair must be purged");
  assert.strictEqual(p.secrets["unrelated:key"], "untouched", "other secrets must be left alone");
});

(async () => {
  for (const [name, fn] of pending) {
    try {
      await fn();
      console.log(`ok   - ${name}`);
    } catch (e) {
      failures++;
      console.error(`FAIL - ${name}\n       ${e.message}`);
    }
  }
  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll BearerAuthProvider tests passed.");
})();
