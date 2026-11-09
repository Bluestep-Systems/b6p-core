// Upload semantics after the push moved to the server compile (ruling 41, ClickUp 86bczwj62).
//
// History: this file began as the snapshot publish guard (ClickUp 86bbqnrtp): core wrote `snapshot/`
// itself and read it back. The platform now writes `snapshot/` (the `takeSnapshot` mutation), so
// the dual write, the read-back and the "snapshot copy is stale" skip rule are gone, and what stays
// is the contract of ScriptFile.upload():
//  - it writes the `draft/` copy only, never `snapshot/`;
//  - a refused PUT throws FileSendError and leaves the sync record alone;
//  - the sync record is written once the draft/ copy lands;
//  - a file whose draft/ copy already matches is skipped without a PUT, and `snapshot/` is never consulted.
//
// b6p-core has no test framework; this is a minimal, dependency-free node script (run via
// `npm test`). It exercises the COMPILED classes from dist/ with a fake ScriptContext, so no
// network or real filesystem is touched. The fake platform keeps the bytes each copy holds.

const path = require("path");
const crypto = require("crypto");
const assert = require("node:assert");
const { ScriptFile } = require("../dist/script/ScriptFile.js");
const { ScriptRoot } = require("../dist/script/ScriptRoot.js");
const { B6PUri } = require("../dist/B6PUri.js");
const { Err } = require("../dist/Err.js");

let failures = 0;
const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const ROOT_PATH = path.join(path.parse(process.cwd()).root, "ws", "U100001", "MyScript");
const FILE_PATH = path.join(ROOT_PATH, "draft", "scripts", "app.ts");
const TARGET = B6PUri.fromFsPath(FILE_PATH).fsPath;
const DRAFT_URL = new URL("https://org.bluestep.net/files/100001/draft/scripts/app.ts");
const SNAPSHOT_URL = "https://org.bluestep.net/files/100001/snapshot/scripts/app.ts";
const LOCAL = "export const version = 'new';\n";

function sha512(content) {
  return crypto.createHash("sha512").update(Buffer.from(content, "utf8")).digest("hex");
}

/**
 * Build a ScriptFile over an in-memory file map and a fake session that records every request.
 *
 * @param opts.draftStatus      status the draft/ PUT answers with
 * @param opts.snapshotStatus   status the snapshot/ PUT answers with
 * @param opts.draftContent     bytes the platform's draft/ copy holds (default: stale "old")
 * @param opts.snapshotContent  bytes the platform's snapshot/ copy holds (default: stale "old");
 *                              `null` means the copy doesn't exist (404, no ETag)
 * @param opts.snapshotStores   what each accepted snapshot/ PUT keeps, in order, instead of the
 *                              bytes sent (an empty or cut-off write; `null` keeps nothing, so
 *                              the copy stays missing); once used up, it keeps the bytes sent
 * @param opts.snapshotHashless the snapshot/ HEAD answers with a numeric ETag (no content hash)
 * @param opts.snapshotHeadFailures statuses the snapshot/ HEADs answer with, in order, before
 *                              answering normally (e.g. `[500]`: the first read-back fails)
 */
function makeScenario(opts) {
  const initial = (content) => (content === undefined ? "old" : content);
  const state = {
    files: { [TARGET]: Buffer.from(LOCAL, "utf8") },
    platform: { draft: initial(opts.draftContent), snapshot: initial(opts.snapshotContent) },
    requests: [],
    metadata: { pushPullRecords: [{ downstairsPath: TARGET, lastVerifiedHash: sha512("old") }] },
  };
  const snapshotStores = [...(opts.snapshotStores || [])];
  const snapshotHeadFailures = [...(opts.snapshotHeadFailures || [])];
  const noop = () => {};
  const logger = { debug: noop, info: noop, warn: noop, error: noop };
  const fs = {
    stat: async (uri) => {
      const bytes = state.files[uri.fsPath];
      if (bytes === undefined) {
        throw new Error("ENOENT");
      }
      return { type: "file", mtime: 0, ctime: 0, size: bytes.length };
    },
    readFile: async (uri) => new Uint8Array(state.files[uri.fsPath]),
  };
  const sessionManager = {
    fetch: async (url, init) => {
      const href = new URL(url).href;
      const method = init && init.method;
      state.requests.push({ method, url: href });
      const copy = href.includes("/snapshot/") ? "snapshot" : "draft";
      if (method === "HEAD") {
        if (copy === "snapshot" && snapshotHeadFailures.length > 0) {
          return new Response(null, { status: snapshotHeadFailures.shift() });
        }
        const held = state.platform[copy];
        if (held === null) {
          return new Response(null, { status: 404 });
        }
        const etag = copy === "snapshot" && opts.snapshotHashless ? '"1727000000000"' : `"${sha512(held)}"`;
        return new Response(null, { status: 200, headers: { ETag: etag } });
      }
      const status = copy === "snapshot" ? opts.snapshotStatus : opts.draftStatus;
      if (status >= 400) {
        return new Response("platform said no", { status });
      }
      const sent = Buffer.from(init.body).toString("utf8");
      state.platform[copy] = copy === "snapshot" && snapshotStores.length > 0 ? snapshotStores.shift() : sent;
      return new Response(null, { status });
    },
  };
  const prompt = {
    confirm: async () => {
      throw new Error("upload() must not prompt in these scenarios");
    },
    warn: noop,
    info: noop,
    error: noop,
    popup: async () => {},
  };
  const ctx = { fs, sessionManager, logger, prompt, isDebugMode: () => false };
  const scriptRoot = {
    ctx,
    factory: {},
    getGitIgnore: async () => [],
    getRootUri: () => B6PUri.fromFsPath(ROOT_PATH),
    getBaseWebDavUrl: async () => new URL("https://org.bluestep.net/files/100001/"),
    getMetaData: async () => state.metadata,
    modifyMetaData: async (fn) => {
      fn(state.metadata);
      return state.metadata;
    },
    withParser: () => scriptRoot,
  };
  const file = new ScriptFile(B6PUri.fromFsPath(FILE_PATH), scriptRoot);
  // Not under test here — see the header.
  file.upstairsUrl = async () => new URL(DRAFT_URL);
  file.isInItsRespectiveBuildFolder = async () => false;
  file.platformChangeAtRisk = async () => null;
  return { file, state, ctx };
}

const recordedHash = (state) => state.metadata.pushPullRecords[0].lastVerifiedHash;
const puts = (state) => state.requests.filter((r) => r.method === "PUT").map((r) => r.url);
const heads = (state) => state.requests.filter((r) => r.method === "HEAD").map((r) => r.url);

test("upload writes draft/ only, never snapshot/, and records the sync", async () => {
  const { file, state } = makeScenario({ draftStatus: 204, snapshotStatus: 500 });
  const resp = await file.upload();
  assert.strictEqual(resp.status, 204);
  assert.deepStrictEqual(puts(state), [DRAFT_URL.href]);
  assert.strictEqual(recordedHash(state), sha512(LOCAL));
});

test("a failed draft/ PUT throws FileSendError naming the URL and leaves the sync record alone", async () => {
  const { file, state } = makeScenario({ draftStatus: 500, snapshotStatus: 201 });
  await assert.rejects(
    () => file.upload(),
    (e) => e instanceof Err.FileSendError && e.message.includes(DRAFT_URL.href) && e.message.includes("500")
  );
  assert.deepStrictEqual(puts(state), [DRAFT_URL.href]);
  assert.strictEqual(recordedHash(state), sha512("old"));
});

test("draft/ matches → skipped without a PUT and without looking at snapshot/", async () => {
  const { file, state } = makeScenario({ draftStatus: 500, snapshotStatus: 500, draftContent: LOCAL });
  const resp = await file.upload();
  assert.strictEqual(resp, undefined);
  assert.deepStrictEqual(heads(state), [DRAFT_URL.href]);
  assert.deepStrictEqual(puts(state), []);
});

test("draft/ matches and snapshot/ is stale → still skipped (the platform owns snapshot/)", async () => {
  const { file, state } = makeScenario({ draftStatus: 204, snapshotStatus: 201, draftContent: LOCAL });
  assert.strictEqual(await file.upload(), undefined);
  assert.deepStrictEqual(puts(state), []);
});

// ScriptRoot.getPushableNodes() asks the skip rule for the draft copy only.
function pushableNodes(file) {
  const noop = () => {};
  const root = {
    ctx: { logger: { debug: noop, info: noop, warn: noop, error: noop } },
    getDraftFolder: () => ({ flatten: async () => [file] }),
  };
  return ScriptRoot.prototype.getPushableNodes.call(root);
}

test("getPushableNodes: draft/ differs → pushable; draft/ matches → excluded", async () => {
  const stale = makeScenario({});
  assert.deepStrictEqual(await pushableNodes(stale.file), [stale.file]);
  const same = makeScenario({ draftContent: LOCAL });
  assert.deepStrictEqual(await pushableNodes(same.file), []);
  assert.deepStrictEqual(heads(same.state), [DRAFT_URL.href]);
});

test("ScriptFile no longer offers a snapshot/ URL helper", () => {
  assert.strictEqual(ScriptFile.snapshotUrl, undefined);
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log("ok   -", name);
    } catch (e) {
      failures++;
      console.error("FAIL -", name, "\n     ", e.message);
    }
  }
  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll upload tests passed.");
})();
