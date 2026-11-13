// Regression tests for the snapshot publish guard's pre-publish half (ClickUp 86bbqnrtp) — `b6p push --snapshot`
// published a compiled entrypoint that was missing or blank.
//
// THE BUG: a snapshot push published whatever the compile left behind. When `scripts/app.ts` compiled to no
// `.build/scripts/app.js`, or to one with no code (a blank or types-only app.ts compiles to just a source-map comment
// and `export {};`), the push still went out and the runtime failed with `NoSuchFileException .../scripts/app` or
// answered an empty 200.
//
// THE FIX: checkEmittedEntrypoint() looks at the compiled entrypoint before anything is pushed, and executePush stops
// with `pushed: false` when it is missing or has no code.
//
// (The other half of the old guard, reading the live `snapshot/` copies back over WebDAV by ETag, is gone: a snapshot
// now publishes through git, and the read-back is "the published branch is at the published sha", covered by
// GitDraftSync.test.js.)
//
// b6p-core has no test framework; this is a minimal, dependency-free node script (run via `npm test`). It exercises
// the COMPILED function from dist/ with a fake file system.

const path = require("path");
const assert = require("node:assert");
const { B6PUri } = require("../dist/B6PUri.js");
const { checkEmittedEntrypoint } = require("../dist/script/push.js");


let failures = 0;
const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}
const ROOT_PATH = path.join(path.parse(process.cwd()).root, "ws", "U100001", "MyScript");

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
