// Behavioral spec for ScriptMetaDataStore write-coalescing (beginBatch/flush).
//
// `pull` wraps its per-script upserts in beginBatch()/flush() so the ~23 writes
// to state.json collapse into a single atomic write, reducing the burst that
// trips AV/ransomware heuristics. This spec pins that behavior: batched upserts
// defer the disk write, flush performs one write, an auto-flush bounds how much
// a crash can lose, nesting only writes on the outermost flush, and pre-existing
// entries are not clobbered.
//
// b6p-core has no test framework; this is a minimal, dependency-free node script
// (run via `npm test`) exercising the COMPILED store from dist/ against an
// in-memory Persistence that counts disk writes.
const assert = require("node:assert");
const { ScriptMetaDataStore } = require("../dist/cache/ScriptMetaDataStore.js");

// The persistence key the store writes under (PublicKeys.SCRIPT_METADATA).
const SCRIPT_METADATA_KEY = "b6p:script_metadata";

/** In-memory Persistence that counts writes and exposes the last stored value. */
function makePersistence(initial) {
  const store = new Map(Object.entries(initial || {}));
  const secrets = new Map();
  let writes = 0;
  let failNext = false;
  return {
    writes: () => writes,
    stored: () => store.get(SCRIPT_METADATA_KEY),
    /** Make the next `set` throw once, to simulate a failed disk write. */
    failNextWrite() {
      failNext = true;
    },
    async get(key) {
      return store.has(key) ? store.get(key) : undefined;
    },
    async set(key, value) {
      if (failNext) {
        failNext = false;
        throw new Error("simulated write failure");
      }
      writes += 1;
      // Deep-clone so later in-memory mutations can't retroactively change what
      // we assert was persisted at write time.
      store.set(key, JSON.parse(JSON.stringify(value)));
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

function meta(i) {
  return { U: "U1", webdavId: String(i), scriptName: "S" + i, scriptKey: null, pushPullRecords: [] };
}

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log("ok   -", name);
  } catch (e) {
    failures++;
    console.error("FAIL -", name, "\n     ", e && e.stack ? e.stack : e);
  }
}

(async () => {
  await test("without a batch, each upsert writes to disk (unchanged behavior)", async () => {
    const p = makePersistence();
    const store = new ScriptMetaDataStore(p);
    await store.whenReady();
    await store.upsert(meta(1));
    await store.upsert(meta(2));
    await store.upsert(meta(3));
    assert.strictEqual(p.writes(), 3, "3 upserts should be 3 writes when not batching");
    assert.strictEqual(store.all().length, 3);
  });

  await test("a batch coalesces many upserts into a single write on flush", async () => {
    const p = makePersistence();
    const store = new ScriptMetaDataStore(p);
    await store.beginBatch();
    for (let i = 1; i <= 5; i++) await store.upsert(meta(i));
    assert.strictEqual(p.writes(), 0, "no disk writes while batching (below the auto-flush threshold)");
    await store.flush();
    assert.strictEqual(p.writes(), 1, "flush performs exactly one write");
    assert.strictEqual(store.all().length, 5);
    assert.strictEqual(p.stored().all.length, 5, "all 5 entries are persisted");
  });

  await test("auto-flush bounds crash loss at the threshold (10)", async () => {
    const p = makePersistence();
    const store = new ScriptMetaDataStore(p);
    await store.beginBatch();
    for (let i = 1; i <= 12; i++) await store.upsert(meta(i));
    // The 10th upsert triggers one auto-flush; the 11th/12th stay pending.
    assert.strictEqual(p.writes(), 1, "one auto-flush after 10 deferred writes");
    await store.flush();
    assert.strictEqual(p.writes(), 2, "final flush writes the remaining entries");
    assert.strictEqual(p.stored().all.length, 12, "nothing is lost across the auto-flush boundary");
  });

  await test("nested batches only write when the outermost flush runs", async () => {
    const p = makePersistence();
    const store = new ScriptMetaDataStore(p);
    await store.beginBatch(); // depth 1
    await store.beginBatch(); // depth 2
    await store.upsert(meta(1));
    await store.flush(); // back to depth 1 — must NOT write yet
    assert.strictEqual(p.writes(), 0, "the inner flush must not write");
    await store.upsert(meta(2));
    await store.flush(); // depth 0 — single write
    assert.strictEqual(p.writes(), 1, "only the outermost flush writes");
    assert.strictEqual(p.stored().all.length, 2);
  });

  await test("beginBatch loads pre-existing entries so flush does not clobber them", async () => {
    const p = makePersistence({ [SCRIPT_METADATA_KEY]: { all: [meta(99)] } });
    const store = new ScriptMetaDataStore(p);
    await store.beginBatch(); // awaits whenReady → loads meta(99)
    await store.upsert(meta(1));
    await store.flush();
    const stored = p
      .stored()
      .all.map((m) => m.webdavId)
      .sort();
    assert.deepStrictEqual(stored, ["1", "99"], "the pre-existing entry must survive the coalesced write");
  });

  await test("a failed flush keeps changes pending so a later flush persists them", async () => {
    const p = makePersistence();
    const store = new ScriptMetaDataStore(p);
    await store.beginBatch();
    await store.upsert(meta(1));
    await store.upsert(meta(2));
    p.failNextWrite();
    await assert.rejects(() => store.flush(), /simulated write failure/);
    assert.strictEqual(p.writes(), 0, "the failed store must not have persisted anything");
    // The changes are still marked pending, so a subsequent flush writes them
    // rather than no-oping (the drop-on-failure regression this guards against).
    await store.flush();
    assert.strictEqual(p.writes(), 1, "a later flush persists the still-pending changes");
    assert.strictEqual(p.stored().all.length, 2, "no batched update is dropped");
  });

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll ScriptMetaDataStore tests passed.");
})();
