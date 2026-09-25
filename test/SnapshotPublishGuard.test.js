// Regression tests for the snapshot publish guard (ClickUp 86bbqnrtp, closed together with
// 86bb94f3j) — `b6p push --snapshot` reported success while the live version was missing,
// empty, or stale.
//
// THE BUG (task 1): ScriptFile.upload() checked the draft/ PUT but never the snapshot/ PUT, so
// a failed snapshot write — the copy the platform runtime actually reads — was reported as a
// clean push while the previous version stayed live. Reproduced 2026-09-25 on bkplayground with
// an injected 500 (`.claude/specs/close-wave-2026-09/validation-2026-09-25.md`, local).
//
// THE FIX: the snapshot/ PUT is checked like the draft/ one and throws FileSendError. The sync
// record (touch) is written right after the draft/ PUT, because it describes the draft/ copy:
// oldIntegrityMatches() compares it with the draft/ ETag, so recording it late would make a
// failed snapshot write look like a platform-side edit on the next push.
//
// THE BUG (task 2): getReasonToNotPush() skipped a file as "File integrity matches" when the draft/
// copy matched, even on a snapshot push. After a failed snapshot/ write, draft/ already holds the
// new bytes, so every later snapshot push skipped the file: zero PUTs, exit 0, and the old version
// stayed live (the "stuck" case in the same validation file).
//
// THE FIX: on a snapshot push a file is skipped only when both draft/ and snapshot/ match local.
// The snapshot/ HEAD is made only when draft/ already matches. Plain pushes stay draft-only.
//
// THE BUG (task 3): the platform can accept a write (2xx) and still serve different bytes. An
// empty or cut-off app.js answered 204 and went live as-is, so a clean upload proved nothing.
//
// THE FIX: verifyLiveSnapshot() HEADs every snapshot/ copy the push wrote and compares its ETag
// with the local SHA-512. A mismatch is re-sent once and checked again; what is still wrong makes
// executePush stop before cleanup and history with `liveVerified: false`. executePush itself needs
// a parser, metadata and GraphQL, so only the helper is tested here; the live run covers the rest.
//
// THE BUG (task 4): a snapshot push published whatever the compile left behind. When
// `scripts/app.ts` compiled to no `.build/scripts/app.js`, or to one with no code (a blank or
// types-only app.ts compiles to just a source-map comment and `export {};`), the push still went
// out and the runtime failed with `NoSuchFileException .../scripts/app` or answered an empty 200.
//
// THE FIX: checkEmittedEntrypoint() looks at the compiled entrypoint before any upload, and
// executePush stops with `pushed: false` when it is missing or has no code.
//
// b6p-core has no test framework; this is a minimal, dependency-free node script (run via
// `npm test`). It exercises the COMPILED classes from dist/ with a fake ScriptContext, so no
// network or real filesystem is touched. The fake platform keeps the bytes each copy holds: a PUT
// replaces them and a HEAD answers with their ETag. The predicates these tasks do not change
// (build-folder membership, the overwrite prompt check) are stubbed per instance.

const path = require("path");
const crypto = require("crypto");
const assert = require("node:assert");
const { ScriptFile } = require("../dist/script/ScriptFile.js");
const { B6PUri } = require("../dist/B6PUri.js");
const { Err } = require("../dist/Err.js");
const { checkEmittedEntrypoint, verifyLiveSnapshot } = require("../dist/script/push.js");

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
 *                              bytes sent (an empty or cut-off write); once used up, it keeps the
 *                              bytes sent
 * @param opts.snapshotHashless the snapshot/ HEAD answers with a numeric ETag (no content hash)
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

test("snapshotUrl swaps the draft segment and leaves the input untouched", () => {
  const draft = new URL("https://target.bluestep.net/files/7/draft/.build/scripts/app.js?x=1");
  const snapshot = ScriptFile.snapshotUrl(draft);
  assert.strictEqual(snapshot.href, "https://target.bluestep.net/files/7/snapshot/.build/scripts/app.js?x=1");
  assert.strictEqual(draft.href, "https://target.bluestep.net/files/7/draft/.build/scripts/app.js?x=1");
});

test("snapshot push: a failed snapshot/ PUT throws FileSendError (it used to be reported as success)", async () => {
  const { file, state } = makeScenario({ draftStatus: 204, snapshotStatus: 500 });
  await assert.rejects(
    () => file.upload({ isSnapshot: true }),
    (e) => e instanceof Err.FileSendError && e.message.includes(SNAPSHOT_URL) && e.message.includes("500")
  );
  assert.deepStrictEqual(puts(state), [DRAFT_URL.href, SNAPSHOT_URL]);
});

test("snapshot push: the sync record is written once draft/ lands, even when snapshot/ then fails", async () => {
  const { file, state } = makeScenario({ draftStatus: 204, snapshotStatus: 500 });
  await assert.rejects(() => file.upload({ isSnapshot: true }), Err.FileSendError);
  assert.strictEqual(recordedHash(state), sha512(LOCAL));
});

test("snapshot push: both writes succeed → resolves with the snapshot/ response and records the sync", async () => {
  const { file, state } = makeScenario({ draftStatus: 204, snapshotStatus: 201 });
  const resp = await file.upload({ isSnapshot: true });
  assert.strictEqual(resp.status, 201);
  assert.deepStrictEqual(puts(state), [DRAFT_URL.href, SNAPSHOT_URL]);
  assert.strictEqual(recordedHash(state), sha512(LOCAL));
});

test("plain push: writes draft/ only", async () => {
  const { file, state } = makeScenario({ draftStatus: 204, snapshotStatus: 500 });
  const resp = await file.upload({ isSnapshot: false });
  assert.strictEqual(resp.status, 204);
  assert.deepStrictEqual(puts(state), [DRAFT_URL.href]);
  assert.strictEqual(recordedHash(state), sha512(LOCAL));
});

test("a failed draft/ PUT throws, never reaches snapshot/, and leaves the sync record alone", async () => {
  const { file, state } = makeScenario({ draftStatus: 500, snapshotStatus: 201 });
  await assert.rejects(
    () => file.upload({ isSnapshot: true }),
    (e) => e instanceof Err.FileSendError && e.message.includes(DRAFT_URL.href)
  );
  assert.deepStrictEqual(puts(state), [DRAFT_URL.href]);
  assert.strictEqual(recordedHash(state), sha512("old"));
});

test("snapshot push: draft/ matches but snapshot/ is stale → uploads (a re-push repairs a stuck snapshot)", async () => {
  const { file, state } = makeScenario({ draftStatus: 204, snapshotStatus: 201, draftContent: LOCAL });
  const resp = await file.upload({ isSnapshot: true });
  assert.strictEqual(resp.status, 201);
  assert.deepStrictEqual(heads(state), [DRAFT_URL.href, SNAPSHOT_URL]);
  assert.deepStrictEqual(puts(state), [DRAFT_URL.href, SNAPSHOT_URL]);
});

test("snapshot push: draft/ matches and snapshot/ is missing → uploads", async () => {
  const { file, state } = makeScenario({
    draftStatus: 204,
    snapshotStatus: 201,
    draftContent: LOCAL,
    snapshotContent: null,
  });
  await file.upload({ isSnapshot: true });
  assert.deepStrictEqual(puts(state), [DRAFT_URL.href, SNAPSHOT_URL]);
});

test("snapshot push: both copies match → skipped, no PUT", async () => {
  const { file, state } = makeScenario({
    draftStatus: 500,
    snapshotStatus: 500,
    draftContent: LOCAL,
    snapshotContent: LOCAL,
  });
  const resp = await file.upload({ isSnapshot: true });
  assert.strictEqual(resp, undefined);
  assert.deepStrictEqual(heads(state), [DRAFT_URL.href, SNAPSHOT_URL]);
  assert.deepStrictEqual(puts(state), []);
});

test("snapshot push: draft/ differs → uploads without the extra snapshot/ HEAD", async () => {
  const { file, state } = makeScenario({ draftStatus: 204, snapshotStatus: 201, snapshotContent: LOCAL });
  await file.upload({ isSnapshot: true });
  assert.deepStrictEqual(heads(state), [DRAFT_URL.href]);
  assert.deepStrictEqual(puts(state), [DRAFT_URL.href, SNAPSHOT_URL]);
});

test("plain push: draft/ matches → skipped without looking at snapshot/", async () => {
  const { file, state } = makeScenario({ draftStatus: 500, snapshotStatus: 500, draftContent: LOCAL });
  const resp = await file.upload({ isSnapshot: false });
  assert.strictEqual(resp, undefined);
  assert.deepStrictEqual(heads(state), [DRAFT_URL.href]);
  assert.deepStrictEqual(puts(state), []);
});

test("read-back: live copy matches → nothing to report, nothing re-sent", async () => {
  const { file, state, ctx } = makeScenario({ snapshotStatus: 201, snapshotContent: LOCAL });
  const check = await verifyLiveSnapshot([file], ctx);
  assert.deepStrictEqual(check, { mismatches: [], indeterminate: [] });
  assert.deepStrictEqual(heads(state), [SNAPSHOT_URL]);
  assert.deepStrictEqual(puts(state), []);
});

test("read-back: an empty live copy is re-sent once, and the retry fixes it", async () => {
  const { file, state, ctx } = makeScenario({ snapshotStatus: 201, snapshotContent: "" });
  const check = await verifyLiveSnapshot([file], ctx);
  assert.deepStrictEqual(check, { mismatches: [], indeterminate: [] });
  assert.deepStrictEqual(heads(state), [SNAPSHOT_URL, SNAPSHOT_URL]);
  assert.deepStrictEqual(puts(state), [SNAPSHOT_URL]);
  assert.strictEqual(state.platform.snapshot, LOCAL);
});

test("read-back: still wrong after the one retry → reported as a mismatch", async () => {
  const { file, state, ctx } = makeScenario({ snapshotStatus: 201, snapshotContent: "", snapshotStores: [""] });
  const check = await verifyLiveSnapshot([file], ctx);
  assert.deepStrictEqual(check, { mismatches: ["scripts/app.ts"], indeterminate: [] });
  assert.deepStrictEqual(puts(state), [SNAPSHOT_URL]);
});

test("read-back: a refused re-send leaves the file a mismatch instead of throwing", async () => {
  const { file, state, ctx } = makeScenario({ snapshotStatus: 500, snapshotContent: "" });
  const check = await verifyLiveSnapshot([file], ctx);
  assert.deepStrictEqual(check, { mismatches: ["scripts/app.ts"], indeterminate: [] });
  assert.deepStrictEqual(puts(state), [SNAPSHOT_URL]);
});

test("read-back: no content hash on the live copy → indeterminate, not a mismatch, nothing re-sent", async () => {
  const { file, state, ctx } = makeScenario({ snapshotStatus: 201, snapshotContent: "", snapshotHashless: true });
  const check = await verifyLiveSnapshot([file], ctx);
  assert.deepStrictEqual(check, { mismatches: [], indeterminate: ["scripts/app.ts"] });
  assert.deepStrictEqual(puts(state), []);
});

test("upload + read-back: the platform keeps an empty snapshot/ write (204) → caught and repaired", async () => {
  const { file, state, ctx } = makeScenario({ draftStatus: 204, snapshotStatus: 204, snapshotStores: [""] });
  assert.ok(await file.upload({ isSnapshot: true }), "upload() must report the write");
  assert.strictEqual(state.platform.snapshot, "");
  const check = await verifyLiveSnapshot([file], ctx);
  assert.deepStrictEqual(check, { mismatches: [], indeterminate: [] });
  assert.deepStrictEqual(puts(state), [DRAFT_URL.href, SNAPSHOT_URL, SNAPSHOT_URL]);
  assert.strictEqual(state.platform.snapshot, LOCAL);
});

/**
 * A read-only fake file system over `{ absolutePath: content }`, for the entrypoint check.
 */
function entrypointFs(files) {
  return {
    exists: async (uri) => uri.fsPath in files,
    readFile: async (uri) => new Uint8Array(Buffer.from(files[uri.fsPath], "utf8")),
  };
}
const DRAFT = B6PUri.fromFsPath(path.join(ROOT_PATH, "draft")).fsPath;
const BUILD = B6PUri.fromFsPath(path.join(ROOT_PATH, "draft", ".build")).fsPath;
const APP_TS = B6PUri.fromFsPath(path.join(DRAFT, "scripts", "app.ts")).fsPath;
const APP_JS = B6PUri.fromFsPath(path.join(BUILD, "scripts", "app.js")).fsPath;

test("entrypoint: app.ts compiled to a non-empty app.js → ok", async () => {
  const fs = entrypointFs({ [APP_TS]: "export const x = 1;", [APP_JS]: "export const x = 1;\n" });
  const check = await checkEmittedEntrypoint({ draftPath: DRAFT, buildFolderPath: BUILD, fs });
  assert.deepStrictEqual(check, { status: "ok", emittedPath: APP_JS });
});

test("entrypoint: app.ts with no compiled app.js → missing", async () => {
  const fs = entrypointFs({ [APP_TS]: "export const x = 1;" });
  const check = await checkEmittedEntrypoint({ draftPath: DRAFT, buildFolderPath: BUILD, fs });
  assert.deepStrictEqual(check, { status: "missing", emittedPath: APP_JS });
});

test("entrypoint: a blank compiled app.js → empty", async () => {
  for (const blank of ["", "\n  \n"]) {
    const fs = entrypointFs({ [APP_TS]: "type X = 1;", [APP_JS]: blank });
    const check = await checkEmittedEntrypoint({ draftPath: DRAFT, buildFolderPath: BUILD, fs });
    assert.deepStrictEqual(check, { status: "empty", emittedPath: APP_JS }, JSON.stringify(blank));
  }
});

// Measured on bkplayground (task 8): a blank app.ts and a types-only one compile to a source-map
// comment (plus `export {};`), never to a blank file. Before this case, both went live and the
// endpoint answered an empty 200.
const SOURCE_MAP = "//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozfQ==";
test("entrypoint: only comments, a source map and empty-module lines → empty", async () => {
  const noCode = [
    SOURCE_MAP,
    `export {};\n${SOURCE_MAP}`,
    `"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\n${SOURCE_MAP}`,
    "/* header */\n// note\nexport {};\n",
  ];
  for (const js of noCode) {
    const fs = entrypointFs({ [APP_TS]: "export type X = 1;", [APP_JS]: js });
    const check = await checkEmittedEntrypoint({ draftPath: DRAFT, buildFolderPath: BUILD, fs });
    assert.deepStrictEqual(check, { status: "empty", emittedPath: APP_JS }, JSON.stringify(js));
  }
});

test("entrypoint: real code next to the source map and module lines → ok", async () => {
  const withCode = [
    `B.net.response.out("x");\n${SOURCE_MAP}`,
    `export {};\nconst u = "http://x"; // url\n${SOURCE_MAP}`,
    `"use strict";\nconsole.log(1);\n`,
  ];
  for (const js of withCode) {
    const fs = entrypointFs({ [APP_TS]: "x", [APP_JS]: js });
    const check = await checkEmittedEntrypoint({ draftPath: DRAFT, buildFolderPath: BUILD, fs });
    assert.deepStrictEqual(check, { status: "ok", emittedPath: APP_JS }, JSON.stringify(js));
  }
});

test("entrypoint: no scripts/app.ts (a JS-only draft) → nothing to check", async () => {
  const fs = entrypointFs({ [B6PUri.fromFsPath(path.join(DRAFT, "scripts", "app.js")).fsPath]: "x" });
  const check = await checkEmittedEntrypoint({ draftPath: DRAFT, buildFolderPath: BUILD, fs });
  assert.strictEqual(check.status, "no-source");
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
  console.log("\nAll SnapshotPublishGuard tests passed.");
})();
