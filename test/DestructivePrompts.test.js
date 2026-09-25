// Regression tests for destructive prompts (ClickUp 86bc2h3ef) — `b6p push --yes` must not accept a
// prompt that overwrites or deletes data.
//
// THE BUG: prompt implementations answer with options[0] on an empty answer and under auto-confirm
// (the CLI's --yes returns options[0] without asking). Two core prompts put the destructive option
// first — the push overwrite prompt ([Overwrite, Cancel]) and the cleanup delete prompt
// ([Yes, No]) — so `--yes` overwrote platform edits and deleted platform-only files. Reproduced
// 2026-09-25 on bkplayground (`.claude/specs/close-wave-2026-09/validation-2026-09-25.md`, local).
//
// THE FIX: every prompt that overwrites or deletes puts its safe option first and passes
// `{ destructive: true, safeOption }` (ConfirmOptions), so an auto-supplied answer declines. Each
// test answers the way --yes does (options[0]) and checks nothing was destroyed, then answers the
// destructive option explicitly and checks the action still runs.
//
// Two follow-ons, because most callers are agents that can't see a prompt:
//  - The overwrite prompt asks only when something is really at risk. A missing sync record used to
//    count as a platform change on its own, so every NEW file asked; with Cancel as the default,
//    `--yes` would then have stopped every push that adds a file.
//  - What is declined says what was kept and why, where a non-interactive caller sees it: the
//    thrown message (OverwriteDeclinedError, with `paths`) and a warning plus the cleanup's
//    returned list (PushResult.keptPlatformOnly). HOW to confirm (a flag, a button, piped input)
//    depends on the consumer, so core's text never says it; the tests assert that.
//
// b6p-core has no test framework; this is a minimal, dependency-free node script (run via
// `npm test`). It exercises the COMPILED code from dist/ with plain-object fakes, so no network or
// real filesystem is touched.

const path = require("path");
const crypto = require("crypto");
const assert = require("node:assert");
const { ScriptFile } = require("../dist/script/ScriptFile.js");
const { ScriptService } = require("../dist/script/ScriptService.js");
const { cleanupUnusedUpstairsPaths } = require("../dist/script/push.js");
const { GlobMatcher } = require("../dist/data/GlobMatcher.js");
const { B6PUri } = require("../dist/B6PUri.js");
const { Err } = require("../dist/Err.js");

let failures = 0;
const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const noop = () => {};
const logger = { debug: noop, info: noop, warn: noop, error: noop };
/** What CliPrompt answers under --yes, and on an empty answer. */
const firstOption = (options) => options[0];
const pick = (label) => () => label;

function sha512(content) {
  return crypto.createHash("sha512").update(Buffer.from(content, "utf8")).digest("hex");
}

/**
 * A Prompt that records every confirm() call and warning, and answers with `answer(options)`.
 */
function recordingPrompt(answer) {
  const calls = [];
  const warnings = [];
  return {
    calls,
    warnings,
    confirm: async (message, options, opts) => {
      calls.push({ message, options, opts });
      return answer(options);
    },
    info: noop,
    warn: (message) => warnings.push(message),
    error: noop,
    popup: async () => {},
  };
}

/**
 * The contract a destructive prompt must meet: marked, with its safe option first and named.
 */
function assertSafeFirst(call, safeOption, destructiveOption) {
  assert.ok(call, "the prompt was never shown");
  assert.strictEqual(call.opts && call.opts.destructive, true, "destructive must be true");
  assert.strictEqual(call.opts.safeOption, safeOption);
  assert.strictEqual(call.options[0], safeOption, "the safe option must come first");
  assert.ok(call.options.includes(destructiveOption), `"${destructiveOption}" must still be offered`);
}

// ── Push overwrite prompt (ScriptFile.upload) ─────────────────────────

const ROOT_PATH = path.join(path.parse(process.cwd()).root, "ws", "U100001", "MyScript");
const FILE_PATH = path.join(ROOT_PATH, "draft", "scripts", "app.ts");
const TARGET = B6PUri.fromFsPath(FILE_PATH).fsPath;
const DRAFT_URL = "https://org.bluestep.net/files/100001/draft/scripts/app.ts";
const LOCAL = "mine";

/**
 * A ScriptFile over one local file, with the platform's draft/ copy and the sync record as given.
 *
 * @param opts.platform bytes the platform's draft/ copy holds; `null` = no copy (404);
 *                      `"hashless"` = served with a numeric ETag (no content hash)
 * @param opts.record   bytes the last sync here recorded; `null` = never synced on this machine
 */
function overwriteScenario(prompt, opts) {
  const requests = [];
  const metadata = {
    pushPullRecords: opts.record === null ? [] : [{ downstairsPath: TARGET, lastVerifiedHash: sha512(opts.record) }],
  };
  const fs = {
    stat: async () => ({ type: "file", mtime: 0, ctime: 0, size: LOCAL.length }),
    readFile: async () => new Uint8Array(Buffer.from(LOCAL, "utf8")),
  };
  const sessionManager = {
    fetch: async (url, init) => {
      const method = init && init.method;
      requests.push({ method, url: new URL(url).href });
      if (method !== "HEAD") {
        return new Response(null, { status: 204 });
      }
      if (opts.platform === null) {
        return new Response(null, { status: 404 });
      }
      const etag = opts.platform === "hashless" ? '"1727000000000"' : `"${sha512(opts.platform)}"`;
      return new Response(null, { status: 200, headers: { ETag: etag } });
    },
  };
  const ctx = { fs, sessionManager, logger, prompt, isDebugMode: () => false };
  const scriptRoot = {
    ctx,
    factory: {},
    getGitIgnore: async () => [],
    getRootUri: () => B6PUri.fromFsPath(ROOT_PATH),
    getMetaData: async () => metadata,
    modifyMetaData: async (fn) => {
      fn(metadata);
      return metadata;
    },
    withParser: () => scriptRoot,
  };
  const file = new ScriptFile(B6PUri.fromFsPath(FILE_PATH), scriptRoot);
  file.upstairsUrl = async () => new URL(DRAFT_URL);
  file.isInItsRespectiveBuildFolder = async () => false;
  const puts = () => requests.filter((r) => r.method === "PUT").map((r) => r.url);
  return { file, puts };
}

/** Someone else changed the platform copy since the last sync here. */
const CHANGED = { platform: "theirs", record: "base" };

test("overwrite prompt: --yes declines, nothing is written, and the error says what and why", async () => {
  const prompt = recordingPrompt(firstOption);
  const { file, puts } = overwriteScenario(prompt, CHANGED);
  await assert.rejects(
    () => file.upload({ isSnapshot: false }),
    (e) =>
      e instanceof Err.OverwriteDeclinedError &&
      e instanceof Err.UserCancelledError &&
      e.message.includes("scripts/app.ts was not overwritten") &&
      e.message.includes("changed on the platform since the last push or pull") &&
      !/answer|--yes|flag/i.test(e.message) &&
      JSON.stringify(e.paths) === JSON.stringify(["scripts/app.ts"])
  );
  assert.strictEqual(prompt.calls.length, 1);
  assertSafeFirst(prompt.calls[0], "Cancel", "Overwrite");
  assert.ok(prompt.calls[0].message.includes(DRAFT_URL), "the prompt must name the platform copy");
  assert.deepStrictEqual(puts(), []);
});

test("overwrite prompt: a dismissed prompt (undefined) declines too", async () => {
  const prompt = recordingPrompt(() => undefined);
  const { file, puts } = overwriteScenario(prompt, CHANGED);
  await assert.rejects(() => file.upload({ isSnapshot: false }), Err.OverwriteDeclinedError);
  assert.deepStrictEqual(puts(), []);
});

test("overwrite prompt: an explicit Overwrite still writes", async () => {
  const prompt = recordingPrompt(pick("Overwrite"));
  const { file, puts } = overwriteScenario(prompt, CHANGED);
  await file.upload({ isSnapshot: false });
  assert.deepStrictEqual(puts(), [DRAFT_URL]);
});

test("overwrite rule: a new file the platform doesn't have → no prompt, so --yes still pushes it", async () => {
  const prompt = recordingPrompt(firstOption);
  const { file, puts } = overwriteScenario(prompt, { platform: null, record: null });
  await file.upload({ isSnapshot: false });
  assert.strictEqual(prompt.calls.length, 0);
  assert.deepStrictEqual(puts(), [DRAFT_URL]);
});

test("overwrite rule: a normal local edit (platform = last sync) → no prompt", async () => {
  const prompt = recordingPrompt(firstOption);
  const { file, puts } = overwriteScenario(prompt, { platform: "base", record: "base" });
  await file.upload({ isSnapshot: false });
  assert.strictEqual(prompt.calls.length, 0);
  assert.deepStrictEqual(puts(), [DRAFT_URL]);
});

test("overwrite rule: the platform already holds the local bytes → no prompt, nothing to write", async () => {
  const prompt = recordingPrompt(firstOption);
  const { file, puts } = overwriteScenario(prompt, { platform: LOCAL, record: "base" });
  await file.upload({ isSnapshot: false });
  assert.strictEqual(prompt.calls.length, 0);
  assert.deepStrictEqual(puts(), []);
});

test("overwrite rule: never synced here and the platform differs → asks, and says so", async () => {
  const prompt = recordingPrompt(firstOption);
  const { file, puts } = overwriteScenario(prompt, { platform: "theirs", record: null });
  await assert.rejects(
    () => file.upload({ isSnapshot: false }),
    (e) => e instanceof Err.OverwriteDeclinedError && e.message.includes("never pulled or pushed")
  );
  assert.ok(prompt.calls[0].message.includes("never pulled or pushed"));
  assert.deepStrictEqual(puts(), []);
});

test("overwrite rule: a platform copy with no content hash can't be compared → asks", async () => {
  const prompt = recordingPrompt(firstOption);
  const { file, puts } = overwriteScenario(prompt, { platform: "hashless", record: "base" });
  await assert.rejects(() => file.upload({ isSnapshot: false }), Err.OverwriteDeclinedError);
  assert.strictEqual(prompt.calls.length, 1);
  assert.deepStrictEqual(puts(), []);
});

// ── Push cleanup delete prompt (cleanupUnusedUpstairsPaths) ───────────

const TARGET_URL = "https://org.bluestep.net/files/100001/";
const DRAFT_PATH = path.join(ROOT_PATH, "draft");
const ORPHAN_URL = "https://org.bluestep.net/files/100001/draft/scripts/old.ts";

/**
 * The platform lists draft/scripts/app.ts and draft/scripts/old.ts; locally only app.ts exists, so
 * old.ts is a platform-only file the cleanup offers to delete.
 */
function cleanupScenario(prompt) {
  const requests = [];
  const tree = {
    [DRAFT_PATH]: [["scripts", "directory"]],
    [path.join(DRAFT_PATH, "scripts")]: [["app.ts", "file"]],
  };
  const fs = { readDirectory: async (uri) => tree[path.normalize(uri.fsPath)] || [] };
  const propfind =
    `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">` +
    `<D:response><D:href>/files/100001/draft/scripts/app.ts</D:href></D:response>` +
    `<D:response><D:href>/files/100001/draft/scripts/old.ts</D:href></D:response>` +
    `</D:multistatus>`;
  const sessionManager = {
    fetch: async (url, init) => {
      const method = init && init.method;
      requests.push({ method, url: new URL(url).href });
      return method === "PROPFIND" ? new Response(propfind, { status: 207 }) : new Response(null, { status: 204 });
    },
  };
  const opts = {
    ctx: { fs, sessionManager, logger, prompt, isDebugMode: () => false },
    targetUrl: TARGET_URL,
    draftPath: DRAFT_PATH,
    gitignoreMatcher: new GlobMatcher(ROOT_PATH, []),
  };
  const deletes = () => requests.filter((r) => r.method === "DELETE").map((r) => r.url);
  return { opts, deletes };
}

test("cleanup prompt: --yes keeps the platform-only file, warns with the list, and returns it", async () => {
  const prompt = recordingPrompt(firstOption);
  const { opts, deletes } = cleanupScenario(prompt);
  const kept = await cleanupUnusedUpstairsPaths(opts);
  assert.strictEqual(prompt.calls.length, 1);
  assertSafeFirst(prompt.calls[0], "No", "Yes");
  assert.ok(prompt.calls[0].message.includes(ORPHAN_URL), "the prompt must list the file");
  assert.deepStrictEqual(deletes(), []);
  assert.deepStrictEqual(kept, ["scripts/old.ts"]);
  assert.strictEqual(prompt.warnings.length, 1);
  assert.ok(prompt.warnings[0].includes(ORPHAN_URL), "the warning must list the file");
  assert.ok(!/answer|--yes|flag/i.test(prompt.warnings[0]), "how to confirm a delete is the consumer's to say");
});

test("cleanup prompt: an explicit Yes still deletes, and nothing is reported as kept", async () => {
  const prompt = recordingPrompt(pick("Yes"));
  const { opts, deletes } = cleanupScenario(prompt);
  const kept = await cleanupUnusedUpstairsPaths(opts);
  assert.deepStrictEqual(deletes(), [ORPHAN_URL]);
  assert.deepStrictEqual(kept, []);
  assert.deepStrictEqual(prompt.warnings, []);
});

// ── Audit-pull prompt (ScriptService.auditPull) ───────────────────────

/**
 * A ScriptService whose audit finds one changed file; pull() only records that it ran.
 */
function auditScenario(prompt) {
  const service = new ScriptService({ logger, prompt });
  const pulls = [];
  service.audit = async () => ({ changedFiles: ["scripts/app.ts"], baseUrl: TARGET_URL });
  service.pull = async (opts) => {
    pulls.push(opts);
  };
  return { service, pulls };
}

test("audit-pull prompt: --yes keeps local edits, nothing is pulled", async () => {
  const prompt = recordingPrompt(firstOption);
  const { service, pulls } = auditScenario(prompt);
  await service.auditPull({ filePath: FILE_PATH, workspacePath: ROOT_PATH });
  assert.strictEqual(prompt.calls.length, 1);
  assertSafeFirst(prompt.calls[0], "Cancel", "Sync");
  assert.deepStrictEqual(pulls, []);
});

test("audit-pull prompt: an explicit Sync still pulls the confirmed files", async () => {
  const prompt = recordingPrompt(pick("Sync"));
  const { service, pulls } = auditScenario(prompt);
  await service.auditPull({ filePath: FILE_PATH, workspacePath: ROOT_PATH });
  assert.strictEqual(pulls.length, 1);
  assert.deepStrictEqual(pulls[0].overwriteLocalPaths, ["scripts/app.ts"]);
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
  console.log("\nAll DestructivePrompts tests passed.");
})();
