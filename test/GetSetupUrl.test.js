// Behavioral spec for `B6PCore.getSetupUrl`.
//
// `getSetupUrl` resolves a script's setup URL from stored metadata. It must read
// through the same ScriptMetaDataStore that `pull` populates and `audit`/`push`
// consume (keyed by U + scriptName), then build the URL via
// ScriptKey.buildSetupUrl against the org origin. When no metadata is stored it
// must fail with a clear "pull first" message rather than a malformed URL.
//
// b6p-core has no test framework; this is a minimal, dependency-free node script
// (run via `npm test`). It exercises the COMPILED B6PCore from dist/ with
// in-memory providers, seeding the same store `pull` writes to.
const assert = require("node:assert");
const { B6PCore } = require("../dist/B6PCore.js");
const { MockFileSystem } = require("../dist/testing/MockFileSystem.js");

const U = "U123456";
const SCRIPT_NAME = "MyReport";
const CLASSID = "530024"; // merge report → editdetailreport1.jsp
const SEQNUM = "202";
const ORIGIN = "https://myorg.bluestep.net/";
// POSIX path inside a script root: <workspace>/<U######>/<scriptName>/draft/...
const FILE_PATH = `/ws/${U}/${SCRIPT_NAME}/draft/scripts/app.ts`;

// The persistence key + serialized shape the ScriptMetaDataStore uses. This is
// exactly what a real `pull` leaves behind (a ScriptKey serialized via its
// `__serializable` tag, revived into a ScriptKey instance on load).
const SCRIPT_METADATA_KEY = "b6p:script_metadata";
function seededMetadata() {
  return {
    all: [
      {
        webdavId: "999",
        scriptName: SCRIPT_NAME,
        U,
        scriptKey: { __serializable: "ScriptKey", classid: CLASSID, seqnum: SEQNUM },
        pushPullRecords: [],
      },
    ],
  };
}

/** Minimal in-memory IPersistence. */
function makePersistence(initial) {
  const store = new Map(Object.entries(initial || {}));
  const secrets = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : undefined;
    },
    async set(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
    async getSecret(key) {
      return secrets.get(key);
    },
    async setSecret(key, value) {
      secrets.set(key, value);
    },
    async deleteSecret(key) {
      secrets.delete(key);
    },
    async clearPublic() {
      store.clear();
    },
    async clearSecrets() {
      secrets.clear();
    },
  };
}

const errors = [];
function makeCore(persistence) {
  const noop = () => {};
  const prompt = {
    error: (m) => errors.push(m),
    info: noop,
    warn: noop,
    inputBox: async () => undefined,
    quickPick: async () => undefined,
    showMessage: noop,
    confirm: async () => false,
  };
  const logger = { info: noop, warn: noop, error: noop, debug: noop };
  const progress = { report: noop, withProgress: async (_o, task) => task({ report: noop }) };
  return new B6PCore({
    fs: new MockFileSystem(),
    persistence,
    prompt,
    logger,
    progress,
    // Supply the org origin directly so URL resolution needs no login/network.
    orgCacheSettings: { getParsedAnyDomainOverrideUrl: () => new URL(ORIGIN) },
  });
}

// NOTE: we deliberately do NOT wait for the persistence maps to finish loading
// before calling getSetupUrl — that mirrors the CLI, which constructs the core
// and immediately runs the command. getSetupUrl must await the metadata store's
// readiness itself; otherwise it reads an empty (still-loading) store and
// wrongly reports "no stored metadata".

let failures = 0;
async function test(name, fn) {
  errors.length = 0;
  try {
    await fn();
    console.log("ok   -", name);
  } catch (e) {
    failures++;
    console.error("FAIL -", name, "\n     ", e.message);
  }
}

(async () => {
  await test("resolves the setup URL from store metadata written by pull", async () => {
    const core = makeCore(makePersistence({ [SCRIPT_METADATA_KEY]: seededMetadata() }));
    const url = await core.getSetupUrl({ filePath: FILE_PATH });
    assert.strictEqual(
      url,
      `${ORIGIN}shared/admin/applications/relate/editdetailreport1.jsp?_event=edit&_id=${CLASSID}___${SEQNUM}`
    );
    assert.deepStrictEqual(errors, [], "no error should be surfaced when metadata exists");
    core.dispose();
  });

  await test("errors clearly when the script has no stored metadata", async () => {
    const core = makeCore(makePersistence({})); // nothing pulled
    const url = await core.getSetupUrl({ filePath: FILE_PATH });
    assert.strictEqual(url, null);
    assert.ok(
      errors.some((m) => /No stored metadata/.test(m) && m.includes(SCRIPT_NAME)),
      "expected a 'No stored metadata' error mentioning the script name, got:\n  " + errors.join("\n  ")
    );
    core.dispose();
  });

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll getSetupUrl tests passed.");
})();
