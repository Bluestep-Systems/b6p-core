// Regression tests for the pull-side divergence guard (ClickUp 86bbdr4r0) —
// `pull` silently overwrote a locally-edited file (reported against
// draft/README.md, which the tooling itself scaffolds) with the platform copy.
//
// THE BUG: ScriptFile.download() wrote the fetched bytes unconditionally —
// nothing between the gitignore check and writeContent() looked at the local
// file. The ETag integrity check also ran AFTER the write, so even a failed
// integrity check left the local file already clobbered.
//
// THE FIX: download() hashes the fetched bytes first. The integrity check runs
// against that hash BEFORE any write, and when the local file has been edited
// since the last push/pull (content hash ≠ recorded lastVerifiedHash) and the
// platform copy differs, the local copy is KEPT and reported — deliberately
// WITHOUT prompting (download runs once per file inside the pull loop, where a
// blocking read can never complete on non-interactive stdin, and a per-file
// prompt would also contradict an already-confirmed audit pull). Flows that
// have confirmed the intent pass `overwriteLocal: true` — scoped per file by
// ScriptService.pull's `overwriteLocalPaths`. A file with differing content
// but NO metadata record overwrites as before: the record store is
// machine-local and routinely empty (fresh clone, new machine), so guarding it
// would make a first pull write nothing. A kept file's metadata stays
// untouched, so `audit` keeps flagging the divergence.
//
// The write itself is ATOMIC (temp sibling + rename): a crash mid-write must
// never leave a truncated file that the guard would then misread as a local
// edit and keep forever.
//
// b6p-core has no test framework; this is a minimal, dependency-free node
// script (run via `npm test`). It exercises the COMPILED classes from dist/
// with a fake ScriptContext so no network or real filesystem is touched.
const path = require("path");
const crypto = require("crypto");
const assert = require("node:assert");
const { ScriptFile } = require("../dist/script/ScriptFile.js");
const { B6PUri } = require("../dist/B6PUri.js");
const { Err } = require("../dist/Err.js");

let failures = 0;
const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const ROOT_PATH = path.join(path.parse(process.cwd()).root, "ws", "U100001", "MyScript");
const FILE_PATH = path.join(ROOT_PATH, "draft", "README.md");
const TARGET = B6PUri.fromFsPath(FILE_PATH).fsPath;

function sha512(content) {
  return crypto.createHash("sha512").update(Buffer.from(content, "utf8")).digest("hex");
}

/**
 * Build a ScriptFile wired to a fake ScriptContext over an in-memory file map,
 * so the atomic temp-write + rename path is exercised for real.
 *
 * @param opts.localContent  current on-disk content, or null when the file does not exist
 * @param opts.remoteContent body the GET returns (its quoted SHA-512 is the ETag unless etagOverride is set)
 * @param opts.lastVerifiedHash recorded hash from the last push/pull, or null for no metadata record
 * @param opts.etagOverride  explicit ETag header value (to force an integrity failure)
 */
function makeScenario(opts) {
  const files = {};
  if (opts.localContent !== null) {
    files[TARGET] = Buffer.from(opts.localContent, "utf8");
  }
  const state = {
    files,
    directTargetWrites: 0, // fs.writeFile aimed straight at the target (must stay 0 — atomicity)
    renamesToTarget: 0, // content arriving at the target via rename
    prompts: 0,
    warns: [],
    metadata: {
      pushPullRecords:
        opts.lastVerifiedHash == null ? [] : [{ downstairsPath: TARGET, lastVerifiedHash: opts.lastVerifiedHash }],
    },
  };

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
    writeFile: async (uri, bytes) => {
      if (uri.fsPath === TARGET) {
        state.directTargetWrites++;
      }
      state.files[uri.fsPath] = Buffer.from(bytes);
    },
    rename: async (from, to) => {
      if (to.fsPath === TARGET) {
        state.renamesToTarget++;
      }
      state.files[to.fsPath] = state.files[from.fsPath];
      delete state.files[from.fsPath];
    },
    delete: async (uri) => {
      delete state.files[uri.fsPath];
    },
  };
  const etag = opts.etagOverride !== undefined ? opts.etagOverride : '"' + sha512(opts.remoteContent) + '"';
  const sessionManager = {
    fetch: async () => new Response(opts.remoteContent, { status: 200, headers: { etag } }),
  };
  const prompt = {
    // download() must NEVER prompt — a blocking read inside the pull loop can
    // never complete on non-interactive stdin.
    confirm: async () => {
      state.prompts++;
      return undefined;
    },
    warn: (message) => {
      state.warns.push(message);
    },
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
  return { file, state };
}

function targetContent(state) {
  return state.files[TARGET] === undefined ? null : state.files[TARGET].toString("utf8");
}

const PLATFORM = "# README\n\nplatform copy\n";
const ORIGINAL = "# README\n\noriginal synced copy\n";
const EDITED = "# README\n\ncarefully written local overview\n";

// ─── cases where writing proceeds ─────────────────────────────────────────────

test("local file absent → downloads and records metadata", async () => {
  const { file, state } = makeScenario({ localContent: null, remoteContent: PLATFORM, lastVerifiedHash: null });
  await file.download();
  assert.strictEqual(targetContent(state), PLATFORM);
  assert.strictEqual(state.metadata.pushPullRecords[0].lastVerifiedHash, sha512(PLATFORM));
});

test("the write is atomic: temp + rename, never a direct truncate of the target", async () => {
  const { file, state } = makeScenario({ localContent: null, remoteContent: PLATFORM, lastVerifiedHash: null });
  await file.download();
  assert.strictEqual(state.directTargetWrites, 0, "target must only ever receive content via rename");
  assert.strictEqual(state.renamesToTarget, 1);
  assert.strictEqual(Object.keys(state.files).length, 1, "no temp file may linger after a successful download");
});

test("local identical to platform copy → no warning, no kept file", async () => {
  const { file, state } = makeScenario({
    localContent: PLATFORM,
    remoteContent: PLATFORM,
    lastVerifiedHash: null,
  });
  await file.download();
  assert.strictEqual(state.warns.length, 0);
});

test("local unmodified since last sync, platform moved → overwrites silently", async () => {
  const { file, state } = makeScenario({
    localContent: ORIGINAL,
    remoteContent: PLATFORM,
    lastVerifiedHash: sha512(ORIGINAL),
  });
  await file.download();
  assert.strictEqual(targetContent(state), PLATFORM);
  assert.strictEqual(state.warns.length, 0);
});

test("no metadata record + differing content → first sync on this machine, overwrites", async () => {
  // The record store is machine-local (fresh clone / new machine / cleared
  // state). Guarding this case would make `pull` write nothing at all there.
  const { file, state } = makeScenario({
    localContent: EDITED,
    remoteContent: PLATFORM,
    lastVerifiedHash: null,
  });
  await file.download();
  assert.strictEqual(targetContent(state), PLATFORM);
});

// ─── the reported case: genuine local edits ──────────────────────────────────

test("locally edited → kept, warned, metadata untouched, no prompt", async () => {
  const { file, state } = makeScenario({
    localContent: EDITED,
    remoteContent: PLATFORM,
    lastVerifiedHash: sha512(ORIGINAL),
  });
  await file.download();
  assert.strictEqual(targetContent(state), EDITED);
  assert.strictEqual(state.renamesToTarget, 0);
  assert.strictEqual(state.directTargetWrites, 0);
  assert.strictEqual(state.warns.length, 1);
  assert.strictEqual(state.prompts, 0, "download() must never prompt");
  // lastVerifiedHash still points at the old sync, so audit keeps flagging this file
  assert.strictEqual(state.metadata.pushPullRecords[0].lastVerifiedHash, sha512(ORIGINAL));
});

test("locally edited + overwriteLocal (confirmed audit pull) → platform copy wins", async () => {
  const { file, state } = makeScenario({
    localContent: EDITED,
    remoteContent: PLATFORM,
    lastVerifiedHash: sha512(ORIGINAL),
  });
  await file.download(undefined, { overwriteLocal: true });
  assert.strictEqual(targetContent(state), PLATFORM);
  assert.strictEqual(state.warns.length, 0);
  assert.strictEqual(state.metadata.pushPullRecords[0].lastVerifiedHash, sha512(PLATFORM));
});

test("locally edited + onLocalKept collector → collected once, no per-file warning", async () => {
  const { file, state } = makeScenario({
    localContent: EDITED,
    remoteContent: PLATFORM,
    lastVerifiedHash: sha512(ORIGINAL),
  });
  const kept = [];
  await file.download(undefined, { onLocalKept: (fsPath) => kept.push(fsPath) });
  assert.deepStrictEqual(kept, [TARGET]);
  assert.strictEqual(targetContent(state), EDITED);
  assert.strictEqual(state.warns.length, 0, "batch callers aggregate; no per-file warning");
});

// ─── integrity ordering: a bad download must not clobber the local file ──────

test("failed ETag integrity check throws BEFORE anything is written", async () => {
  const { file, state } = makeScenario({
    localContent: ORIGINAL,
    remoteContent: PLATFORM,
    lastVerifiedHash: sha512(ORIGINAL),
    etagOverride: '"' + "a".repeat(128) + '"',
  });
  await assert.rejects(() => file.download(), Err.FileIntegrityError);
  assert.strictEqual(targetContent(state), ORIGINAL);
  assert.strictEqual(state.directTargetWrites + state.renamesToTarget, 0);
  assert.strictEqual(Object.keys(state.files).length, 1, "no temp file may be written before integrity passes");
});

// ─── ETag shapes (b6p-cli#35) ────────────────────────────────────────────────
// download() checks the bytes against a SHA-512 ETag (strong or weak), skips the check for a
// numeric or complex one, and throws EtagParsingError on anything else. The platform sends files
// last saved before about May 2026 with a WEAK numeric ETag, which matched none of the patterns,
// so the pull stopped at the first such file.

const WEAK_NUMERIC_ETAG = 'W/"1775493039859-123320___3785956"';

test("weak numeric ETag (b6p-cli#35) → downloads with no integrity check and records the file", async () => {
  const { file, state } = makeScenario({
    localContent: null,
    remoteContent: PLATFORM,
    lastVerifiedHash: null,
    etagOverride: WEAK_NUMERIC_ETAG,
  });
  await file.download();
  assert.strictEqual(targetContent(state), PLATFORM);
  assert.deepStrictEqual(state.metadata.pushPullRecords, [
    { downstairsPath: TARGET, lastVerifiedHash: sha512(PLATFORM) },
  ]);
});

test("weak numeric ETag keeps the file's sync record and moves it to the new bytes", async () => {
  // The .gitignore workaround in the issue dropped this record; the fix must not.
  const { file, state } = makeScenario({
    localContent: ORIGINAL,
    remoteContent: PLATFORM,
    lastVerifiedHash: sha512(ORIGINAL),
    etagOverride: WEAK_NUMERIC_ETAG,
  });
  await file.download();
  assert.strictEqual(targetContent(state), PLATFORM);
  assert.deepStrictEqual(state.metadata.pushPullRecords, [
    { downstairsPath: TARGET, lastVerifiedHash: sha512(PLATFORM) },
  ]);
});

test("strong numeric ETag → still downloads with no integrity check", async () => {
  const { file, state } = makeScenario({
    localContent: null,
    remoteContent: PLATFORM,
    lastVerifiedHash: null,
    etagOverride: '"1700000000000-123_456"',
  });
  await file.download();
  assert.strictEqual(targetContent(state), PLATFORM);
});

test("complex memory-document ETag → still downloads with no integrity check", async () => {
  const { file, state } = makeScenario({
    localContent: null,
    remoteContent: PLATFORM,
    lastVerifiedHash: null,
    etagOverride: '"1700000000000-{"class": "myassn.document.LibraryServletMemoryDocumentKey", "classId": 42}"',
  });
  await file.download();
  assert.strictEqual(targetContent(state), PLATFORM);
});

test("weak SHA-512 ETag, matching bytes → still downloads", async () => {
  const { file, state } = makeScenario({
    localContent: null,
    remoteContent: PLATFORM,
    lastVerifiedHash: null,
    etagOverride: 'W/"' + sha512(PLATFORM) + '"',
  });
  await file.download();
  assert.strictEqual(targetContent(state), PLATFORM);
});

test("weak SHA-512 ETag, different bytes → still FileIntegrityError before anything is written", async () => {
  const { file, state } = makeScenario({
    localContent: ORIGINAL,
    remoteContent: PLATFORM,
    lastVerifiedHash: sha512(ORIGINAL),
    etagOverride: 'W/"' + "a".repeat(128) + '"',
  });
  await assert.rejects(() => file.download(), Err.FileIntegrityError);
  assert.strictEqual(targetContent(state), ORIGINAL);
  assert.strictEqual(state.directTargetWrites + state.renamesToTarget, 0);
});

test("unrecognised ETag → still EtagParsingError before anything is written", async () => {
  const garbage = [
    '"not-an-etag"',
    'W/"not-an-etag"',
    'W/"' + "a".repeat(64) + '"', // a hash, but not SHA-512 length
    'W/"177549303-123320"', // numeric, but 9 digits: not a millisecond timestamp
    'W/"1775493039859-123320___3785956x"',
  ];
  for (const etag of garbage) {
    const { file, state } = makeScenario({
      localContent: ORIGINAL,
      remoteContent: PLATFORM,
      lastVerifiedHash: sha512(ORIGINAL),
      etagOverride: etag,
    });
    await assert.rejects(() => file.download(), Err.EtagParsingError, `expected EtagParsingError for ${etag}`);
    assert.strictEqual(targetContent(state), ORIGINAL);
    assert.strictEqual(state.directTargetWrites + state.renamesToTarget, 0);
  }
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
  console.log("\nAll PullDivergenceGuard tests passed.");
})();
