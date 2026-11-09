// The local fallback compiler (ruling 44): ScriptTranspiler on TypeScript 7.1's native full-program
// API (`typescript/sync`), ported from the TypeScript 5.9 in-process compiler.
// TODO(2026-12-09): remove the local TS 7.1 fallback once every namespace runs web >= MIN_SERVER_VERSION (ruling 44)
//
// Regression tests for the pre-publish type-check declarations gap (ClickUp 86bbeb659).
//
// THE BUG: `b6p push --snapshot` transpiled `scripts/app.ts` in isolation. The transpile builds its
// own root-file list by walking the `draft/` folder, so the tsconfig's `include` — which points
// OUTSIDE `draft/` at the sibling `../declarations/index.d.ts` — was dropped. Every platform global
// (B, console, MEFR_*, the Bluestep namespace, …) then resolved to "Cannot find name", the JS was
// emitted anyway (noEmitOnError:false), and the push reported success having type-checked nothing
// but syntax.
//
// THE FIX: ScriptTranspiler.resolveDeclarationRootFiles() keeps the ambient `.d.ts` a tsconfig's
// include/files pull in, and transpile() adds them to the program's root files. Ambient `.d.ts`
// emit nothing, so this changes only what is type-checked, not what is emitted.
//
// Also pinned here: a const enum imported across files is inlined (full program, not per-file
// transpile), diagnostics keep the `file (line,col): message` shape, and the native compiler
// process is closed after every transpile, including one that throws.
//
// b6p-core has no test framework; this is a minimal, dependency-free node script (run via
// `npm test`). It spawns the real native compiler against on-disk fixtures in a temp dir.
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("node:assert");
const childProcess = require("child_process");
const {
  ScriptTranspiler,
  startNativeCompiler,
  resolveNativeCompilerPath,
} = require("../dist/script/ScriptTranspiler.js");
const { Err } = require("../dist/Err.js");

let failures = 0;
const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const NOOP_LOGGER = { info() {}, warn() {}, debug() {}, error() {} };

// Build a throwaway component tree under a fresh temp dir:
//   <root>/declarations/index.d.ts
//   <root>/draft/tsconfig.json   (include drives resolution)
//   <root>/draft/scripts/*.ts    (from `scripts`)
function makeFixture(includeList, scripts = { "app.ts": "B;\n" }, compilerOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "b6p-transpile-"));
  const declDir = path.join(root, "declarations");
  const draftDir = path.join(root, "draft");
  const scriptsDir = path.join(draftDir, "scripts");
  fs.mkdirSync(declDir, { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(path.join(declDir, "index.d.ts"), "declare const B: unknown;\n");
  for (const [name, text] of Object.entries(scripts)) {
    fs.writeFileSync(path.join(scriptsDir, name), text);
  }
  const tsconfigPath = path.join(draftDir, "tsconfig.json");
  fs.writeFileSync(
    tsconfigPath,
    JSON.stringify({
      compilerOptions: { module: "ESNext", target: "ES2022", outDir: ".build", strict: true, ...compilerOptions },
      include: includeList,
    })
  );
  return { root, draftDir, scriptsDir, tsconfigPath };
}

function rmrf(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

/** Runs `fn(api)` with a real compiler session, always closed. */
async function withApi(cwd, fn) {
  const api = await startNativeCompiler(cwd);
  try {
    return await fn(api);
  } finally {
    api.close();
  }
}

/** The transpile's options for a fixture, from the real parse (what transpile() itself does). */
function optionsFor(api, fx) {
  const parsed = api.parseConfigFile(fx.tsconfigPath);
  return ScriptTranspiler.applyTranspileInvariants({ ...parsed.options }, fx.draftDir);
}

const messages = (diagnostics) => diagnostics.map((d) => d.text);
const slash = (p) => p.replace(/\\/g, "/");

/** A ScriptNode stand-in: the members ScriptTranspiler.addFile reads. */
function fakeNode(fsPath, tsconfigPath) {
  return {
    isFolder: async () => false,
    isCopacetic: async () => true,
    getClosestTsConfigFile: async () => ({ path: () => tsconfigPath }),
    path: () => fsPath,
    uri: () => ({ fsPath }),
  };
}

/** A ScriptRoot stand-in: the members transpile() reads. */
function fakeRoot(fx) {
  return {
    getDraftTsConfigPath: () => path.normalize(fx.tsconfigPath),
    getDraftFolder: () => ({ uri: () => ({ fsPath: fx.draftDir }) }),
  };
}

// ── resolveDeclarationRootFiles ──

test("resolves the sibling ../declarations/index.d.ts named in include", async () => {
  const fx = makeFixture(["../declarations/index.d.ts", "scripts/**/*.ts"]);
  try {
    await withApi(fx.draftDir, (api) => {
      const decls = ScriptTranspiler.resolveDeclarationRootFiles(api.parseConfigFile(fx.tsconfigPath));
      assert.strictEqual(decls.length, 1, "exactly the one declaration file");
      assert.ok(slash(decls[0]).endsWith("/declarations/index.d.ts"), `got: ${decls[0]}`);
      assert.strictEqual(decls[0], path.normalize(decls[0]), "returned as a native path");
    });
  } finally {
    rmrf(fx.root);
  }
});

test("returns only .d.ts, never the emitting scripts/*.ts sources", async () => {
  const fx = makeFixture(["../declarations/index.d.ts", "scripts/**/*.ts"]);
  try {
    await withApi(fx.draftDir, (api) => {
      const decls = ScriptTranspiler.resolveDeclarationRootFiles(api.parseConfigFile(fx.tsconfigPath));
      assert.ok(decls.every((f) => f.toLowerCase().endsWith(".d.ts")), `got: ${decls.join(", ")}`);
    });
  } finally {
    rmrf(fx.root);
  }
});

test("no declarations in include → empty (nothing to add)", async () => {
  const fx = makeFixture(["scripts/**/*.ts"]);
  try {
    await withApi(fx.draftDir, (api) => {
      assert.deepStrictEqual(ScriptTranspiler.resolveDeclarationRootFiles(api.parseConfigFile(fx.tsconfigPath)), []);
    });
  } finally {
    rmrf(fx.root);
  }
});

test("a declaration listed but absent on disk is dropped (no phantom root file)", async () => {
  const fx = makeFixture(["../declarations/missing.d.ts", "scripts/**/*.ts"]);
  try {
    await withApi(fx.draftDir, (api) => {
      assert.deepStrictEqual(ScriptTranspiler.resolveDeclarationRootFiles(api.parseConfigFile(fx.tsconfigPath)), []);
    });
  } finally {
    rmrf(fx.root);
  }
});

// ── compileProject: the real program build ──

test("WITH declarations: the platform global resolves and only app.js is emitted", async () => {
  const fx = makeFixture(["../declarations/index.d.ts", "scripts/**/*.ts"]);
  try {
    await withApi(fx.draftDir, (api) => {
      const decls = ScriptTranspiler.resolveDeclarationRootFiles(api.parseConfigFile(fx.tsconfigPath));
      const appTs = path.join(fx.scriptsDir, "app.ts");
      const res = ScriptTranspiler.compileProject(api, [appTs], decls, optionsFor(api, fx));
      assert.strictEqual(res.emitSkipped, false, "emit must not be skipped");
      assert.ok(!messages(res.diagnostics).some((m) => m.includes("Cannot find name 'B'")), "B must resolve");
      const emitted = res.emittedFiles.map(slash);
      assert.deepStrictEqual(
        emitted.map((f) => path.posix.relative(slash(fx.draftDir), f)),
        [".build/scripts/app.js"],
        "only app.js, under rootDir-relative .build/scripts/"
      );
      assert.ok(res.emittedFiles.every((f) => f === path.normalize(f)), "emitted paths are native");
    });
  } finally {
    rmrf(fx.root);
  }
});

test("WITHOUT declarations: the same program cannot resolve the platform global", async () => {
  const fx = makeFixture(["../declarations/index.d.ts", "scripts/**/*.ts"]);
  try {
    await withApi(fx.draftDir, (api) => {
      const appTs = path.join(fx.scriptsDir, "app.ts");
      const res = ScriptTranspiler.compileProject(api, [appTs], [], optionsFor(api, fx));
      assert.ok(messages(res.diagnostics).some((m) => m.includes("Cannot find name 'B'")), "B must be unresolved");
    });
  } finally {
    rmrf(fx.root);
  }
});

test("a const enum imported from another file is inlined, as the 5.9 full program did", async () => {
  const fx = makeFixture(["../declarations/index.d.ts", "scripts/**/*.ts"], {
    "enums.ts": "export const enum Color { Red = 1, Green = 2 }\n",
    "app.ts": 'import { Color } from "./enums";\nexport const c: Color = Color.Green;\n',
  });
  try {
    await withApi(fx.draftDir, (api) => {
      const files = ["enums.ts", "app.ts"].map((f) => path.join(fx.scriptsDir, f));
      const res = ScriptTranspiler.compileProject(api, files, [], optionsFor(api, fx));
      assert.deepStrictEqual(messages(res.diagnostics), []);
      const appJs = fs.readFileSync(path.join(fx.draftDir, ".build", "scripts", "app.js"), "utf8");
      assert.match(appJs, /export const c = 2 \/\* Color\.Green \*\/;/);
      assert.ok(!/import/.test(appJs), `the const-enum-only import is elided, got:\n${appJs}`);
    });
  } finally {
    rmrf(fx.root);
  }
});

// ── transpile(): gating, formatting and the compiler process ──

test("transpile: a type error is counted and formatted as `file (line,col): message`; emit still happens", async () => {
  const fx = makeFixture(["../declarations/index.d.ts", "scripts/**/*.ts"], {
    "app.ts": 'B;\nconst n: number = "x";\nexport {};\n',
  });
  try {
    const t = new ScriptTranspiler({ logger: NOOP_LOGGER });
    await t.addFile(fakeNode(path.join(fx.scriptsDir, "app.ts"), fx.tsconfigPath));
    const out = await t.transpile(fakeRoot(fx));
    assert.strictEqual(out.diagnosticCount, 1);
    const appTs = path.join(fx.scriptsDir, "app.ts");
    assert.ok(out.diagnosticText.startsWith(`${appTs} (2,7): `), out.diagnosticText);
    assert.match(out.diagnosticText, /Type 'string' is not assignable to type 'number'/);
    assert.deepStrictEqual(out.emittedFiles, [path.join(fx.draftDir, ".build", "scripts", "app.js")]);
  } finally {
    rmrf(fx.root);
  }
});

test("transpile: a clean draft-root project counts 0; nothing added counts null and starts no compiler", async () => {
  const fx = makeFixture(["../declarations/index.d.ts", "scripts/**/*.ts"]);
  try {
    let started = 0;
    const counting = async (cwd) => {
      started++;
      return startNativeCompiler(cwd);
    };
    const t = new ScriptTranspiler({ logger: NOOP_LOGGER }, counting);
    await t.addFile(fakeNode(path.join(fx.scriptsDir, "app.ts"), fx.tsconfigPath));
    assert.strictEqual((await t.transpile(fakeRoot(fx))).diagnosticCount, 0);
    const empty = await new ScriptTranspiler({ logger: NOOP_LOGGER }, counting).transpile(fakeRoot(fx));
    assert.deepStrictEqual(empty, { emittedFiles: [], diagnosticCount: null, diagnosticText: "" });
    assert.strictEqual(started, 1);
  } finally {
    rmrf(fx.root);
  }
});

test("transpile: one compiler session for all projects, closed afterwards (later use fails)", async () => {
  const fx = makeFixture(["../declarations/index.d.ts", "scripts/**/*.ts"]);
  const staticDir = path.join(fx.draftDir, "static");
  fs.mkdirSync(staticDir);
  fs.writeFileSync(path.join(staticDir, "tsconfig.json"), JSON.stringify({ compilerOptions: { outDir: ".build" } }));
  fs.writeFileSync(path.join(staticDir, "script.ts"), "export const x = 1;\n");
  try {
    const sessions = [];
    const t = new ScriptTranspiler({ logger: NOOP_LOGGER }, async (cwd) => {
      const api = await startNativeCompiler(cwd);
      const session = { api, closed: 0 };
      sessions.push(session);
      return {
        parseConfigFile: (f) => api.parseConfigFile(f),
        createProgram: (r, o) => api.createProgram(r, o),
        close: () => {
          session.closed++;
          api.close();
        },
      };
    });
    await t.addFile(fakeNode(path.join(fx.scriptsDir, "app.ts"), fx.tsconfigPath));
    await t.addFile(fakeNode(path.join(staticDir, "script.ts"), path.join(staticDir, "tsconfig.json")));
    const out = await t.transpile(fakeRoot(fx));
    assert.strictEqual(out.emittedFiles.length, 2);
    assert.strictEqual(sessions.length, 1, "one native process per push");
    assert.strictEqual(sessions[0].closed, 1);
    assert.throws(() => sessions[0].api.parseConfigFile(fx.tsconfigPath), /closed/i, "the process is gone");
  } finally {
    rmrf(fx.root);
  }
});

test("transpile: the compiler is closed when the program build throws, and the error propagates", async () => {
  let closed = 0;
  const boom = new Error("native compiler crashed");
  const t = new ScriptTranspiler({ logger: NOOP_LOGGER }, async () => ({
    parseConfigFile: () => ({ fileNames: [], options: {}, errors: [] }),
    createProgram: () => {
      throw boom;
    },
    close: () => closed++,
  }));
  const tsconfig = path.join(os.tmpdir(), "x", "draft", "tsconfig.json");
  await t.addFile(fakeNode(path.join(os.tmpdir(), "x", "draft", "scripts", "app.ts"), tsconfig));
  await assert.rejects(() => t.transpile(), (e) => e === boom);
  assert.strictEqual(closed, 1);
});

test("transpile: a skipped emit throws CompilationError, and the compiler is still closed", async () => {
  let closed = 0;
  const program = {
    getProgramDiagnostics: () => [],
    getSyntacticDiagnostics: () => [],
    getGlobalDiagnostics: () => [],
    getSemanticDiagnostics: () => [],
    emit: () => ({ emitSkipped: true, diagnostics: [{ text: "nope", code: 1, category: 1, pos: 0, end: 0 }] }),
  };
  const t = new ScriptTranspiler({ logger: NOOP_LOGGER }, async () => ({
    parseConfigFile: () => ({ fileNames: [], options: {}, errors: [] }),
    createProgram: () => program,
    close: () => closed++,
  }));
  const tsconfig = path.join(os.tmpdir(), "x", "draft", "tsconfig.json");
  await t.addFile(fakeNode(path.join(os.tmpdir(), "x", "draft", "scripts", "app.ts"), tsconfig));
  await assert.rejects(
    () => t.transpile(),
    (e) => e instanceof Err.CompilationError && /emit was skipped/.test(e.message) && /nope/.test(e.message)
  );
  assert.strictEqual(closed, 1);
});

test("the native compiler is found and test-run; one that cannot run is a typed error, not a crash", async () => {
  const exe = resolveNativeCompilerPath();
  assert.ok(fs.existsSync(exe.replace(/^\\\\\?\\/, "")), exe);
  const original = childProcess.spawnSync;
  childProcess.spawnSync = () => ({ error: Object.assign(new Error("spawn EACCES"), { code: "EACCES" }), status: null });
  try {
    assert.throws(
      () => resolveNativeCompilerPath(),
      (e) =>
        e instanceof Err.LocalCompilerUnavailableError &&
        e.serverVersion === null &&
        e.reason === null &&
        /EACCES/.test(String(e.cause)) &&
        /could not be run/.test(e.message)
    );
    await assert.rejects(() => startNativeCompiler(os.tmpdir()), (e) => e instanceof Err.LocalCompilerUnavailableError);
  } finally {
    childProcess.spawnSync = original;
  }
});

test("formatDiagnostics flattens a message chain one indented line per level", () => {
  const text = ScriptTranspiler.formatDiagnostics([
    {
      fileName: path.join(os.tmpdir(), "a.ts"),
      startPosition: { line: 0, character: 4 },
      text: "top",
      messageChain: [{ text: "middle", messageChain: [{ text: "bottom" }] }],
    },
    { text: "global, no file" },
  ]);
  assert.strictEqual(text, `${path.join(os.tmpdir(), "a.ts")} (1,5): top\n  middle\n    bottom\nglobal, no file`);
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log("ok   -", name);
    } catch (e) {
      failures++;
      console.error("FAIL -", name, "\n     ", e && e.stack ? e.stack : e);
    }
  }
  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exit(1);
  }
  console.log(`\nAll ${tests.length} TranspileDeclarations tests passed.`);
})();
