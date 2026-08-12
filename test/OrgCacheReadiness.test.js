// Behavioral spec for `OrgCache`'s initial-load readiness.
//
// The bug this pins down: `PublicPersistanceMap` loads asynchronously and
// *reassigns* its backing object when the load lands. `OrgCache`'s constructor
// used to run its cleanup pass synchronously, so the pass iterated a still-empty
// map and then `store()`d that emptiness over the real file. Constructing a
// B6PCore was therefore enough to wipe the persisted org cache — invisibly, since
// the in-memory copy arrived a moment later and looked correct for the rest of
// the session.
//
// Dependency-free node script (run via `npm test`). Exercises the COMPILED
// OrgCache from dist/, not src/.

const assert = require("node:assert");
const { OrgCache } = require("../dist/cache/OrgCache.js");

const U_CACHE_KEY = "b6p:u_cache";
const NOOP_LOGGER = { info() {}, warn() {}, error() {}, debug() {} };
const NOOP_SETTINGS = { getParsedAnyDomainOverrideUrl: () => null };

/** In-memory Persistence double that counts writes. */
function makePersistence(initial) {
  const store = { [U_CACHE_KEY]: initial };
  const state = { writes: 0 };
  return {
    state,
    read: () => store[U_CACHE_KEY],
    persistence: {
      get: async (k) => store[k],
      set: async (k, v) => {
        state.writes++;
        store[k] = JSON.parse(JSON.stringify(v));
      },
      delete: async () => {},
      getSecret: async () => undefined,
      setSecret: async () => {},
      deleteSecret: async () => {},
      clearPublic: async () => {},
      clearSecrets: async () => {},
    },
  };
}

function freshEntry(host) {
  return [{ host, lastAccess: Date.now() }];
}

function staleEntry(host) {
  const fourDaysAgo = Date.now() - 4 * 24 * 60 * 60 * 1_000;
  return [{ host, lastAccess: fourDaysAgo }];
}

function newCache(persistence) {
  return new OrgCache(persistence, NOOP_LOGGER, NOOP_SETTINGS, () => false);
}

async function run() {
  // ── 1. Construction must not clobber a populated cache ────────────────
  {
    const p = makePersistence({ U123456: freshEntry("example.bluestep.net") });
    const before = JSON.stringify(p.read());
    const cache = newCache(p.persistence);
    await cache.whenReady();
    assert.strictEqual(JSON.stringify(p.read()), before, "construction must leave a populated cache untouched");
    assert.strictEqual(p.state.writes, 0, "construction must not write at all when nothing expired");
    cache.dispose();
    console.log("ok   - constructing OrgCache does not wipe the persisted cache");
    console.log("ok   - construction performs zero writes when nothing has expired");
  }

  // ── 2. Entries written before the load lands are not lost ─────────────
  // The map reassigns its backing object on load, so a pre-load write would be
  // discarded. Every public method awaits readiness, so this must hold.
  {
    const p = makePersistence({ U111111: freshEntry("first.bluestep.net") });
    const cache = newCache(p.persistence);
    await cache.addHost("U222222", new URL("https://second.bluestep.net"));
    await cache.whenReady();
    const onDisk = p.read();
    assert.ok(onDisk.U111111, "the pre-existing entry must survive");
    assert.ok(onDisk.U222222, "an entry added before the load landed must survive");
    cache.dispose();
    console.log("ok   - a write issued before the initial load completes is not discarded");
  }

  // ── 3. Expiry still works, and still writes when it fires ─────────────
  {
    const p = makePersistence({ U333333: staleEntry("old.bluestep.net") });
    const cache = newCache(p.persistence);
    await cache.whenReady();
    assert.deepStrictEqual(p.read(), {}, "entries older than 3 days must be dropped");
    assert.strictEqual(p.state.writes, 1, "expiry must persist exactly one write");
    cache.dispose();
    console.log("ok   - stale entries are still expired, and the expiry is persisted");
  }

  // ── 4. Mixed: stale dropped, fresh kept ───────────────────────────────
  {
    const p = makePersistence({
      U444444: staleEntry("gone.bluestep.net"),
      U555555: freshEntry("kept.bluestep.net"),
    });
    const cache = newCache(p.persistence);
    await cache.whenReady();
    const onDisk = p.read();
    assert.ok(!onDisk.U444444, "the stale entry must be dropped");
    assert.ok(onDisk.U555555, "the fresh entry must be kept");
    cache.dispose();
    console.log("ok   - a mixed cache keeps fresh entries and drops stale ones");
  }

  // ── 5. findUCacheOnly reports a miss rather than lying, pre-load ───────
  {
    const p = makePersistence({ U666666: freshEntry("sync.bluestep.net") });
    const cache = newCache(p.persistence);
    // Called synchronously, before the load: must not throw, must report a miss.
    const early = cache.findUCacheOnly(new URL("https://sync.bluestep.net"));
    assert.strictEqual(early, null, "a pre-load synchronous lookup must report a miss, not throw");
    await cache.whenReady();
    const late = cache.findUCacheOnly(new URL("https://sync.bluestep.net"));
    assert.strictEqual(late, "U666666", "after readiness the same lookup must hit");
    cache.dispose();
    console.log("ok   - findUCacheOnly reports a miss before load, and hits after");
  }

  // ── 6. Partial expiry writes exactly once ─────────────────────────────
  // The removal path (case 3) writes once via the explicit store(). The PARTIAL
  // path also calls set(), which by default stores on the spot — so the sweep used
  // to issue two writes for one sweep.
  {
    const fourDaysAgo = Date.now() - 4 * 24 * 60 * 60 * 1_000;
    const p = makePersistence({
      U777777: [
        { host: "old.bluestep.net", lastAccess: fourDaysAgo },
        { host: "new.bluestep.net", lastAccess: Date.now() },
      ],
    });
    const cache = newCache(p.persistence);
    await cache.whenReady();
    const onDisk = p.read();
    assert.strictEqual(onDisk.U777777.length, 1, "only the fresh host must remain");
    assert.strictEqual(onDisk.U777777[0].host, "new.bluestep.net");
    assert.strictEqual(p.state.writes, 1, "a partial expiry must persist exactly one write, not two");
    cache.dispose();
    console.log("ok   - a partial expiry writes exactly once");
  }

  // ── 7. dispose() before the load lands must not arm a timer ───────────
  // The first sweep is deferred onto the load, so _cleanupTimer is still null
  // during the construction tick; a dispose() in that window cleared nothing and
  // the deferred sweep then armed a self-rearming 1-day timer on a dead object.
  {
    const p = makePersistence({});
    const cache = newCache(p.persistence);
    cache.dispose(); // same tick, before the load resolves
    await cache.whenReady();
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(cache._cleanupTimer, null, "dispose() before readiness must leave no live timer");
    console.log("ok   - dispose() before the initial load leaves no timer armed");
  }

  // ── 8. A Persistence that throws must not produce an unhandled rejection ──
  {
    const throwing = {
      get: async () => ({ U888888: [{ host: "x.bluestep.net", lastAccess: 0 }] }),
      set: () => {
        throw new Error("synchronous persistence failure");
      },
      delete: async () => {},
      getSecret: async () => undefined,
      setSecret: async () => {},
      deleteSecret: async () => {},
      clearPublic: async () => {},
      clearSecrets: async () => {},
    };
    const cache = newCache(throwing);
    await cache.whenReady(); // must resolve, not reject
    assert.strictEqual(await cache.findU("https://x.bluestep.net", true).then(
      () => true,
      (e) => !/synchronous persistence failure/.test(String(e))
    ), true, "a failed initial sweep must not poison every later call");
    cache.dispose();
    console.log("ok   - a throwing Persistence does not reject the readiness promise");
  }

  console.log("\nAll OrgCache readiness tests passed.");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
