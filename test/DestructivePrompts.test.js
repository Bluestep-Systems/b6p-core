// Regression tests for destructive prompts (ClickUp 86bc2h3ef) — `b6p audit --pull --yes` must not accept a
// prompt that overwrites local edits.
//
// THE BUG: prompt implementations answer with options[0] on an empty answer and under auto-confirm (the CLI's --yes
// returns options[0] without asking). Core prompts that put the destructive option first let `--yes` overwrite data.
//
// THE FIX: every prompt that overwrites or deletes puts its safe option first and passes
// `{ destructive: true, safeOption }` (ConfirmOptions), so an auto-supplied answer declines. Each test answers the way
// --yes does (options[0]) and checks nothing was destroyed, then answers the destructive option explicitly and checks
// the action still runs.
//
// This file covers the audit-pull prompt. The push-side prompts (overwriting a platform version, deleting a
// platform-only file) ask over git now and are covered, with the same safe-first assertions, by GitDraftSync.test.js.
//
// b6p-core has no test framework; this is a minimal, dependency-free node script (run via `npm test`). It exercises
// the COMPILED code from dist/ with plain-object fakes, so no network or real filesystem is touched.

const path = require("path");
const assert = require("node:assert");
const { ScriptService } = require("../dist/script/ScriptService.js");

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


const ROOT_PATH = path.join(path.parse(process.cwd()).root, "ws", "U100001", "MyScript");
const FILE_PATH = path.join(ROOT_PATH, "draft", "scripts", "app.ts");
const TARGET_URL = "https://org.bluestep.net/files/100001/";

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
