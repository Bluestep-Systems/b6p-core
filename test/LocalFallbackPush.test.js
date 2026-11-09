// Push routing and the local fallback push, end to end (ruling 44, ClickUp 86bczwj62).
// TODO(2026-12-09): remove the local TS 7.1 fallback once every namespace runs web >= MIN_SERVER_VERSION (ruling 44)
//
// executePush asks /appinfo/version once and picks who compiles: a `dev` server or one at or above
// the floor compiles itself (PUT draft/ sources -> GraphQL compileDraft -> takeSnapshot); any other
// server (below the floor, an unreadable version, or the floor unset) gets the push as it ran
// before 0.9.0, compiled locally with the bundled TypeScript 7.1: sources AND `.build` to draft/
// and snapshot/, the post-publish read-back, cleanup and the history entry.
//
// Dependency-free; runs the COMPILED executePush from dist/ over a real temp-dir script tree (the
// native compiler reads the disk) with a small disk FileSystem, a fake platform that keeps what
// each URL holds (PUT stores, HEAD answers its SHA-512 ETag), scripted GraphQL and in-memory
// metadata. ScriptUrlParser's GraphQL lookups are stubbed on its prototype.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const Module = require("module");
const assert = require("node:assert");
const { B6PUri } = require("../dist/B6PUri.js");
const { Err } = require("../dist/Err.js");
const { executePush } = require("../dist/script/push.js");
const { ScriptUrlParser } = require("../dist/data/ScriptUrlParser.js");

let failures = 0;
const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}
const noop = () => {};
const sha512 = (buf) => crypto.createHash("sha512").update(buf).digest("hex");

const SCRIPT_KEY = {
  classid: "363769",
  mutationName: "updateScriptEndpoint",
  inputType: "UpdateScriptEndpointInput",
  toCompoundId: () => "363769___1",
};
ScriptUrlParser.prototype.getScriptBaseKey = async () => SCRIPT_KEY;
ScriptUrlParser.prototype.getScriptName = async () => "MyScript";
ScriptUrlParser.prototype.getU = async () => "U100001";

const ORIGIN = "https://org.bluestep.net";
const TARGET = `${ORIGIN}/files/100001/`;

/** A FileSystem over the real disk: the members the push and the script tree use. */
const diskFs = {
  readFile: async (uri) => new Uint8Array(fs.readFileSync(uri.fsPath)),
  writeFile: async (uri, content) => {
    fs.mkdirSync(path.dirname(uri.fsPath), { recursive: true });
    fs.writeFileSync(uri.fsPath, content);
  },
  stat: async (uri) => {
    const st = fs.statSync(uri.fsPath);
    return { type: st.isDirectory() ? "directory" : "file", mtime: st.mtimeMs, size: st.size };
  },
  readDirectory: async (uri) =>
    fs.readdirSync(uri.fsPath, { withFileTypes: true }).map((d) => [d.name, d.isDirectory() ? "directory" : "file"]),
  delete: async (uri, options) => fs.rmSync(uri.fsPath, { recursive: !!(options && options.recursive), force: true }),
  createDirectory: async (uri) => fs.mkdirSync(uri.fsPath, { recursive: true }),
  exists: async (uri) => fs.existsSync(uri.fsPath),
  copy: async (a, b) => fs.copyFileSync(a.fsPath, b.fsPath),
  rename: async (a, b) => fs.renameSync(a.fsPath, b.fsPath),
  findFiles: async (base, include) => {
    // Only "**/<name>" is used (findTsConfigFiles).
    const name = include.replace(/^\*\*\//, "");
    const out = [];
    const walk = (dir) => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, d.name);
        if (d.isDirectory()) {
          walk(full);
        } else if (d.name === name) {
          out.push(B6PUri.fromFsPath(full));
        }
      }
    };
    walk(base.fsPath);
    return out;
  },
  closest: async (start, name, maxDepth = 10) => {
    let dir = fs.existsSync(start.fsPath) && fs.statSync(start.fsPath).isDirectory() ? start.fsPath : path.dirname(start.fsPath);
    for (let i = 0; i <= maxDepth; i++) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) {
        return B6PUri.fromFsPath(candidate);
      }
      const up = path.dirname(dir);
      if (up === dir) {
        break;
      }
      dir = up;
    }
    return null;
  },
  isWritableFileSystem: () => true,
};

/** <tmp>/ws/U100001/MyScript with declarations/, draft/tsconfig.json and draft/scripts/{app,enums}.ts. */
function makeScript(app = 'import { Color } from "./enums";\nB.log("c" + Color.Green);\nexport {};\n') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "b6p-fallback-"));
  const rootPath = path.join(tmp, "ws", "U100001", "MyScript");
  const draft = path.join(rootPath, "draft");
  fs.mkdirSync(path.join(draft, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(rootPath, "declarations"), { recursive: true });
  fs.writeFileSync(path.join(rootPath, "declarations", "index.d.ts"), "declare const B: { log(m: string): void };\n");
  fs.writeFileSync(
    path.join(draft, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { module: "ESNext", target: "ES2022", outDir: ".build", strict: true },
      include: ["../declarations/index.d.ts", "scripts/**/*.ts"],
    })
  );
  fs.writeFileSync(path.join(draft, "scripts", "enums.ts"), "export const enum Color { Red = 1, Green = 2 }\n");
  fs.writeFileSync(path.join(draft, "scripts", "app.ts"), app);
  return { tmp, rootPath, draft };
}

/**
 * A fake platform + context. `version` answers /appinfo/version: `{ body }`, `{ status }` or an Error.
 */
function makeCtx(version) {
  const platform = new Map(); // href -> Buffer
  const requests = [];
  const gql = [];
  const warnings = [];
  const errors = [];
  const metadata = [];
  const ctx = {
    fs: diskFs,
    isDebugMode: () => false,
    logger: { debug: noop, info: noop, warn: noop, error: noop },
    prompt: {
      confirm: async (_m, options) => options[0],
      warn: (m) => warnings.push(m),
      info: noop,
      error: (m) => errors.push(m),
      popup: async () => {},
      inputBox: async () => undefined,
    },
    progress: {
      withProgress: async (tasks) => {
        const out = [];
        for (const t of tasks) {
          out.push(await t.execute());
        }
        return out;
      },
    },
    scriptMetadataStore: {
      whenReady: async () => {},
      findByScriptName: (U, name) => metadata.find((m) => m.U === U && m.scriptName === name),
      upsert: async (entry) => {
        if (!metadata.includes(entry)) {
          metadata.push(entry);
        }
      },
    },
    orgCache: { getAnyBaseUrl: async () => new URL(ORIGIN + "/") },
    sessionManager: {
      fetch: async (url, init) => {
        const href = new URL(url).href;
        const method = (init && init.method) || "GET";
        requests.push(`${method} ${href}`);
        if (href === `${ORIGIN}/appinfo/version`) {
          if (version instanceof Error) {
            throw version;
          }
          return new Response(version.body ?? "", { status: version.status ?? 200 });
        }
        if (method === "HEAD") {
          const held = platform.get(href);
          return held === undefined
            ? new Response(null, { status: 404 })
            : new Response(null, { status: 200, headers: { ETag: `"${sha512(held)}"` } });
        }
        if (method === "PUT") {
          platform.set(href, Buffer.from(init.body));
          return new Response(null, { status: 201 });
        }
        if (method === "PROPFIND") {
          return new Response('<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"></D:multistatus>', { status: 207 });
        }
        return new Response(null, { status: 404 });
      },
      csrfFetch: async (url, init) => {
        const sent = JSON.parse(init.body);
        const input = sent.variables.inputs[0];
        const action = input.compileDraft ? "compileDraft" : input.takeSnapshot ? "takeSnapshot" : "history";
        gql.push(action);
        if (action === "compileDraft") {
          const c = { script: "363769___1", status: "COMPILED", errors: 0, warnings: 0, written: 2, deleted: 0 };
          return new Response(JSON.stringify({ extensions: { bluestepCompile: [{ ...c, diagnostics: [] }] } }));
        }
        if (action === "takeSnapshot") {
          const p = { script: "363769___1", published: true, written: 2, deleted: 0, errors: 0, warnings: 0 };
          return new Response(JSON.stringify({ extensions: { bluestepPublish: [{ ...p, diagnostics: [] }] } }));
        }
        return new Response(JSON.stringify({ data: { updateScriptEndpoint: [{ id: "1" }] } }));
      },
    },
  };
  const puts = () => requests.filter((r) => r.startsWith("PUT ")).map((r) => r.slice(4 + TARGET.length));
  return { ctx, platform, requests, gql, warnings, errors, puts };
}

async function push(version, opts = {}) {
  const s = makeScript(opts.app);
  const h = makeCtx(version);
  try {
    const result = await executePush({
      ctx: h.ctx,
      targetUrl: TARGET + "draft",
      rootPath: s.rootPath,
      snapshot: opts.snapshot ?? true,
      serverVersionFloor: "floor" in opts ? opts.floor : "26.11.16.00",
      sleep: async () => {},
    });
    return { ...h, result, script: s, error: null };
  } catch (error) {
    return { ...h, result: null, script: s, error };
  } finally {
    fs.rmSync(s.tmp, { recursive: true, force: true });
  }
}

const SOURCES = ["draft/scripts/app.ts", "draft/scripts/enums.ts", "draft/tsconfig.json"];
const sorted = (a) => [...a].sort();

// ── route selection through executePush ──

test("dev → server flow: sources to draft/ only, then compileDraft + takeSnapshot; no local compile", async () => {
  const r = await push({ body: "dev" });
  assert.strictEqual(r.error, null, String(r.error && r.error.stack));
  assert.strictEqual(r.result.compileMode, "server");
  assert.deepStrictEqual(r.result.route, { mode: "server", reason: "dev", serverVersion: "dev", required: "26.11.16.00" });
  assert.deepStrictEqual(sorted(r.puts()), SOURCES);
  assert.deepStrictEqual(r.gql, ["compileDraft", "takeSnapshot", "history"]);
  assert.strictEqual(r.result.compile.status, "COMPILED");
  assert.strictEqual(r.result.typeCheckDiagnostics, undefined, "local-only fields are absent on the server path");
  assert.strictEqual(r.result.liveVerified, undefined);
});

test("at the floor → server flow", async () => {
  const r = await push({ body: "26.11.16.00\n" });
  assert.strictEqual(r.result.compileMode, "server");
  assert.strictEqual(r.result.route.reason, "at-or-above-floor");
  assert.ok(!r.puts().some((p) => p.includes(".build") || p.startsWith("snapshot/")));
});

test("below the floor → local fallback: compiled .build + sources to draft/ and snapshot/, read back, history", async () => {
  const r = await push({ body: "26.11.02.05" });
  assert.strictEqual(r.error, null, String(r.error && r.error.stack));
  const res = r.result;
  assert.strictEqual(res.compileMode, "local");
  assert.deepStrictEqual(res.route, {
    mode: "local",
    reason: "below-floor",
    serverVersion: "26.11.02.05",
    required: "26.11.16.00",
  });
  assert.strictEqual(res.pushed, true);
  assert.strictEqual(res.compile, null);
  assert.strictEqual(res.publish, null);
  assert.strictEqual(res.typeCheckDiagnostics, 0, "type-checked clean (B resolves from declarations)");
  assert.strictEqual(res.liveVerified, true);
  assert.deepStrictEqual(res.liveMismatches, []);
  assert.strictEqual(res.historyRecorded, true);
  const built = ["draft/.build/scripts/app.js", "draft/.build/scripts/enums.js"];
  const draftSide = sorted([...SOURCES, ...built]);
  assert.deepStrictEqual(sorted(r.puts().filter((p) => p.startsWith("draft/"))), draftSide);
  assert.deepStrictEqual(
    sorted(r.puts().filter((p) => p.startsWith("snapshot/"))),
    draftSide.map((p) => p.replace(/^draft\//, "snapshot/"))
  );
  assert.deepStrictEqual(r.gql, ["history"], "no compileDraft / takeSnapshot on the local path");
  const appJs = r.platform.get(`${TARGET}snapshot/.build/scripts/app.js`).toString("utf8");
  assert.match(appJs, /B\.log\("c" \+ 2 \/\* Color\.Green \*\/\);/, "the cross-file const enum is inlined");
  // The read-back HEADs every snapshot/ copy it wrote.
  const snapshotHeads = r.requests.filter((q) => q.startsWith(`HEAD ${TARGET}snapshot/`));
  assert.ok(snapshotHeads.length >= draftSide.length, snapshotHeads.join("\n"));
});

test("below the floor, plain push → local path without a compile: draft/ only, no .build", async () => {
  const r = await push({ body: "26.11.02.05" }, { snapshot: false });
  assert.strictEqual(r.result.compileMode, "local");
  assert.strictEqual(r.result.typeCheckDiagnostics, null);
  assert.strictEqual(r.result.liveVerified, null);
  assert.deepStrictEqual(sorted(r.puts()), SOURCES);
  assert.deepStrictEqual(r.gql, []);
});

test("unreadable version (404, garbage, network failure) → local fallback, reason unknown", async () => {
  for (const [answer, seen] of [
    [{ status: 404, body: "no" }, null],
    [{ body: "banana" }, "banana"],
    [new Error("ECONNRESET"), null],
  ]) {
    const r = await push(answer, { snapshot: false });
    assert.strictEqual(r.error, null, String(r.error));
    assert.strictEqual(r.result.compileMode, "local");
    assert.strictEqual(r.result.route.reason, "unknown");
    assert.strictEqual(r.result.route.serverVersion, seen);
  }
});

test("floor unset (the shipped default) → every release tag takes the fallback; dev still the server", async () => {
  const r = await push({ body: "40.01.01.00" }, { snapshot: false, floor: null });
  assert.strictEqual(r.result.compileMode, "local");
  assert.strictEqual(r.result.route.reason, "floor-unset");
  const d = await push({ body: "dev" }, { snapshot: false, floor: null });
  assert.strictEqual(d.result.compileMode, "server");
  const shipped = await push({ body: "40.01.01.00" }, { snapshot: false, floor: undefined });
  assert.strictEqual(shipped.result.route.reason, "floor-unset", "MIN_SERVER_VERSION is still unset");
});

// ── local path guards ──

test("local snapshot: a types-only app.ts compiles to an empty entrypoint → nothing uploaded", async () => {
  const r = await push({ body: "26.11.02.05" }, { app: "export type T = string;\n" });
  assert.strictEqual(r.result.pushed, false);
  assert.strictEqual(r.result.compileMode, "local");
  assert.deepStrictEqual(r.puts(), []);
  assert.match(r.errors[0], /has no code/);
});

test("local snapshot: a type error still publishes, counted and warned", async () => {
  const r = await push({ body: "26.11.02.05" }, { app: 'const n: number = "x";\nB.log(String(n));\nexport {};\n' });
  assert.strictEqual(r.result.pushed, true);
  assert.strictEqual(r.result.typeCheckDiagnostics, 1);
  assert.ok(r.warnings.some((w) => /WITHOUT a passing type-check/.test(w)));
});

test("local snapshot without the native compiler → LocalCompilerUnavailableError, nothing uploaded", async () => {
  const original = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (/^@typescript\/typescript-[^/]+\/package\.json$/.test(request)) {
      const e = new Error(`Cannot find module '${request}'`);
      e.code = "MODULE_NOT_FOUND";
      throw e;
    }
    return original.call(this, request, ...rest);
  };
  let r;
  try {
    r = await push({ body: "26.11.02.05" });
  } finally {
    Module._resolveFilename = original;
  }
  assert.ok(r.error instanceof Err.LocalCompilerUnavailableError, String(r.error));
  assert.ok(r.error instanceof Err.CompilationError);
  assert.strictEqual(r.error.serverVersion, "26.11.02.05");
  assert.strictEqual(r.error.reason, "below-floor");
  assert.match(String(r.error.cause), /Cannot find module/);
  assert.match(r.error.message, /Nothing was uploaded/);
  assert.ok(!/--|flag|reinstall|npm/i.test(r.error.message), "says what happened, not how to fix it");
  assert.deepStrictEqual(r.puts(), []);
  assert.deepStrictEqual(r.gql, []);
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (e) {
      failures++;
      console.error(`not ok - ${name}\n  ${e && e.stack ? e.stack : e}`);
    }
  }
  if (failures > 0) {
    console.error(`${failures} failed`);
    process.exit(1);
  }
  console.log(`${tests.length} passed`);
})();
