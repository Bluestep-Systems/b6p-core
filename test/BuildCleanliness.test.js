// Behavioral spec for build cleanliness (build manifest spec §6, "Fully clean"): a snapshot push writes the build
// manifest only when every project wrote its output and none reported an error. Anything else writes none, leaving any
// existing manifest as it is, so the publish is refused until a clean rebuild.
//
// Two levels: the pure rule (buildUncleanReasons), one case per way a build can be unclean, and real snapshot pushes
// (executePush over a real draft folder, the real TypeScript compile, the platform stand-in) for the cases a compile
// can produce. Dependency-free node script over the COMPILED dist/ (run via `npm test`). Needs `git` on the PATH.

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStub } = require("../packages/bsjs-git/test/support/GitProxyStub");
const core = require("../dist/index.js");
const { pullDraft } = require("../dist/script/GitSync.js");
const { executePush } = require("../dist/script/push.js");

const AUTHOR = { name: "Ada Tester", email: "ada@example.test" };
let failures = 0;
const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// ── the pure rule ─────────────────────────────────────────────────────

const clean = (extra = {}) => ({
  tsConfigPath: "/d/tsconfig.json",
  errorCount: 0,
  configErrorCount: 0,
  emittedFiles: ["/d/.build/scripts/app.js"],
  noEmit: false,
  emitSkipped: false,
  ...extra,
});

test("a clean project is clean", () => {
  assert.deepStrictEqual(core.buildUncleanReasons([clean()], "/d"), []);
});

test("each way a project can fail to write its output, or report an error, makes the build unclean", () => {
  const cases = {
    "a syntax or emit error": clean({ errorCount: 1 }),
    "a tsconfig with configuration diagnostics": clean({ configErrorCount: 1 }),
    noEmit: clean({ noEmit: true, emittedFiles: [] }),
    "an emit skipped or withheld (noEmitOnError)": clean({ emitSkipped: true, emittedFiles: [] }),
    "an emit that wrote nothing": clean({ emittedFiles: [] }),
    "output written outside the tree": clean({ emittedFiles: ["/out/app.js"] }),
  };
  for (const [what, report] of Object.entries(cases)) {
    assert.ok(core.buildUncleanReasons([report], "/d").length > 0, what);
  }
  assert.ok(
    core.buildUncleanReasons([clean(), clean({ tsConfigPath: "/d/client/tsconfig.json", errorCount: 2 })], "/d")
      .length > 0,
    "a client bundle's error counts too"
  );
  assert.deepStrictEqual(
    core.buildUncleanReasons([clean({ emittedFiles: ["/out/app.js"] })]),
    [],
    "no root: the location check is skipped"
  );
});

// ── real snapshot pushes ──────────────────────────────────────────────

const stub = createStub();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "b6p-clean-"));
let baseUrl;
let n = 0;
const noop = () => {};
const prompt = {
  confirm: async (_m, o) => o[0],
  warn: (m) => prompt.warnings.push(m),
  info: noop,
  error: noop,
  popup: async () => {},
  warnings: [],
};

function realFs() {
  const walk = (dir, out) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, out);
      } else {
        out.push(full);
      }
    }
    return out;
  };
  const { B6PUri } = require("../dist/B6PUri.js");
  return {
    exists: async (uri) => fs.existsSync(uri.fsPath),
    readFile: async (uri) => new Uint8Array(fs.readFileSync(uri.fsPath)),
    readDirectory: async (uri) =>
      fs.readdirSync(uri.fsPath, { withFileTypes: true }).map((e) => [e.name, e.isDirectory() ? "directory" : "file"]),
    findFiles: async (base, pattern) => {
      const name = pattern.replace(/^\*\*\//, "");
      return fs.existsSync(base.fsPath)
        ? walk(base.fsPath, [])
            .filter((f) => path.basename(f) === name)
            .map((f) => B6PUri.fromFsPath(f))
        : [];
    },
    stat: async (uri) => {
      const s = fs.statSync(uri.fsPath);
      return { type: s.isDirectory() ? "directory" : "file", mtime: s.mtimeMs, ctime: s.ctimeMs, size: s.size };
    },
    createDirectory: async (uri) => fs.mkdirSync(uri.fsPath, { recursive: true }),
    writeFile: async (uri, bytes) => fs.writeFileSync(uri.fsPath, bytes),
    delete: async (uri, o) => fs.rmSync(uri.fsPath, { recursive: o?.recursive === true, force: true }),
    closest: async (start, name) => {
      const here = start.fsPath.replace(/[\\/]+$/, "");
      let dir = fs.existsSync(here) && fs.statSync(here).isDirectory() ? here : path.dirname(here);
      for (;;) {
        if (fs.existsSync(path.join(dir, name))) {
          return B6PUri.fromFsPath(path.join(dir, name));
        }
        const up = path.dirname(dir);
        if (up === dir) {
          return null;
        }
        dir = up;
      }
    },
  };
}

function context(scriptId) {
  const [classid, seqnum] = scriptId.split("___");
  const csrfFetch = async (_u, init) => {
    const id = /"id":"([^"]+)"/.exec(init.body)[1];
    const parents = id.startsWith("530001___")
      ? [{ id: "media-library" }]
      : [{ id: `${classid}___${seqnum}`, displayName: "MyScript" }];
    return new Response(JSON.stringify({ data: { parents } }), { status: 200 });
  };
  const metadata = { pushPullRecords: [] };
  return {
    fs: realFs(),
    gitFs: fs,
    gitToken: async () => stub.TOKEN,
    gitEnv: {},
    prompt,
    logger: { debug: noop, info: noop, warn: noop, error: noop },
    sessionManager: { csrfFetch },
    scriptMetadataStore: { whenReady: async () => {}, findByScriptName: () => metadata, upsert: async () => {} },
    typescriptLibDirs: [path.join(process.cwd(), "node_modules", "typescript", "lib")],
    isDebugMode: () => false,
  };
}

/** Seeds a script whose draft has `files`, pulls it, and runs a snapshot executePush after writing `edits`. */
async function snapshotPush(files, edits) {
  const id = `654015___${8000 + ++n}`;
  stub.addRepo(id, { files });
  const rootPath = path.join(tmp, `ws${n}`, "U100001", "MyScript");
  const ctx = context(id);
  const [classid, seqnum] = id.split("___");
  await pullDraft({ ctx, script: { classid, seqnum }, baseUrl, draftPath: path.join(rootPath, "draft") });
  for (const [rel, text] of Object.entries(edits)) {
    fs.mkdirSync(path.dirname(path.join(rootPath, "draft", rel)), { recursive: true });
    fs.writeFileSync(path.join(rootPath, "draft", rel), text);
  }
  prompt.warnings.length = 0;
  const result = await executePush({
    ctx,
    targetUrl: `${baseUrl}files/100001/`,
    rootPath,
    snapshot: true,
    author: AUTHOR,
  }).catch((error) => ({ error: Object.assign({ message: error.message, stack: error.stack }) }));
  const manifest = (() => {
    try {
      return stub.git(stub.repos.get(id).bare, "show", "draft:.build/.b6p-build.json");
    } catch {
      return undefined;
    }
  })();
  return { id, rootPath, result, manifest };
}

const TSCONFIG = (options = {}) =>
  JSON.stringify({
    compilerOptions: { outDir: ".build", module: "esnext", target: "es2022", ...options },
    include: ["scripts/**/*.ts"],
  });
const SEED = (options) => ({ "tsconfig.json": TSCONFIG(options), "scripts/app.ts": "export const v = 1;\n" });

test("a clean build writes the manifest in the same push, and the publish passes", async () => {
  const { result, manifest } = await snapshotPush(SEED(), { "scripts/app.ts": "export const v = 2;\n" });
  assert.strictEqual(result.pushed, true, JSON.stringify(result));
  assert.ok(manifest, "manifest committed");
  assert.strictEqual(result.publishRefusal, null);
  assert.ok(result.publishedSha);
});

test("a semantic type error is a warning: the JS is emitted, the manifest is written, the publish passes, the error is reported located", async () => {
  const { result, manifest } = await snapshotPush(SEED(), {
    "scripts/app.ts": "export const v: number = 'not a number';\n",
  });
  assert.strictEqual(result.pushed, true);
  assert.ok(result.typeCheckDiagnostics > 0);
  assert.ok(manifest, "a type error does not block the manifest");
  assert.strictEqual(result.publishRefusal, null);
  assert.ok(result.publishedSha);
  assert.strictEqual(result.typeCheckErrors.length, result.typeCheckDiagnostics);
  assert.deepStrictEqual(
    {
      file: result.typeCheckErrors[0].file,
      line: result.typeCheckErrors[0].line,
      column: result.typeCheckErrors[0].column,
      code: result.typeCheckErrors[0].code,
    },
    { file: "scripts/app.ts", line: 1, column: 14, code: 2322 }
  );
  assert.ok(/not assignable/.test(result.typeCheckErrors[0].message));
});

test("a syntax error in the script's own source makes the build unclean: no manifest, and the publish is refused", async () => {
  const { result, manifest } = await snapshotPush(SEED(), { "scripts/app.ts": "export const = ;\n" });
  assert.strictEqual(result.pushed, true);
  assert.strictEqual(manifest, undefined);
  assert.strictEqual(result.publishRefusal.reason, "BUILD_MANIFEST_MISSING");
  assert.ok(prompt.warnings.some((w) => /not fully clean/.test(w) && /syntax or emit/.test(w)));
});

test("a diagnostic in a .d.ts is ignored entirely: not counted, and the build stays clean", async () => {
  const { result, manifest } = await snapshotPush(SEED(), {
    "scripts/app.ts": "export const v = 5;\n",
    "types/generated.d.ts": "declare const g: ;;\ndeclare const h: number\n",
  });
  assert.strictEqual(result.typeCheckDiagnostics, 0, JSON.stringify(result.typeCheckErrors));
  assert.deepStrictEqual(result.typeCheckErrors, []);
  assert.ok(manifest, "the build is clean");
  assert.strictEqual(result.publishRefusal, null);
});

test("a syntax error does not overwrite an existing manifest: it stays, goes stale, and the publish is refused", async () => {
  const first = await snapshotPush(SEED(), { "scripts/app.ts": "export const v = 2;\n" });
  assert.ok(first.manifest);
  const ctx = context(first.id);
  fs.writeFileSync(path.join(first.rootPath, "draft", "scripts", "app.ts"), "export const = 'broken';\n");
  const second = await executePush({
    ctx,
    targetUrl: `${baseUrl}files/100001/`,
    rootPath: first.rootPath,
    snapshot: true,
    author: AUTHOR,
  });
  const after = stub.git(stub.repos.get(first.id).bare, "show", "draft:.build/.b6p-build.json");
  assert.strictEqual(after, first.manifest, "the manifest is exactly as it was");
  assert.strictEqual(second.publishRefusal.reason, "BUILD_STALE");
});

test("noEmit: the compile does not write output, the push stops before sending anything, and no manifest exists", async () => {
  const { result, manifest } = await snapshotPush(SEED({ noEmit: true }), {
    "scripts/app.ts": "export const v = 3;\n",
  });
  assert.ok(result.error || result.pushed === false, "the build is a failure, not a clean success");
  assert.strictEqual(manifest, undefined);
});

test("a tsconfig with a configuration diagnostic (an unknown option): no manifest", async () => {
  const { result, manifest } = await snapshotPush(SEED({ definitelyNotAnOption: true }), {
    "scripts/app.ts": "export const v = 4;\n",
  });
  assert.strictEqual(manifest, undefined, JSON.stringify(result));
  assert.ok(prompt.warnings.some((w) => /configuration diagnostic/.test(w)) || result.error);
});

(async () => {
  baseUrl = await stub.listen();
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log("ok   -", name);
    } catch (e) {
      failures++;
      console.error("FAIL -", name, "\n     ", e && e.stack ? e.stack.split("\n").slice(0, 7).join("\n      ") : e);
    }
  }
  await stub.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll BuildCleanliness tests passed.");
})();
