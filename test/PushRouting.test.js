// Push routing by server version (ruling 46, ClickUp 86bczwj62), end to end.
//
// executePush asks /appinfo/version once. A `dev` server or one at or above the floor takes the server
// flow (PUT draft/ sources -> GraphQL compileDraft -> takeSnapshot). Any other server (below the
// floor, an unreadable version, or the floor unset) takes the draft-only route: sources PUT to draft/
// (plus the usual cleanup), ZERO compile or snapshot GraphQL calls, and a snapshot push reports
// `snapshotRefused` instead of publishing. A plain push is never refused.
//
// Dependency-free; runs the COMPILED executePush from dist/ over a real temp-dir script tree with a
// small disk FileSystem, a fake platform that keeps what each URL holds and scripted GraphQL.
// ScriptUrlParser's GraphQL lookups are stubbed on its prototype.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const assert = require("node:assert");
const { B6PUri } = require("../dist/B6PUri.js");
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
    let dir =
      fs.existsSync(start.fsPath) && fs.statSync(start.fsPath).isDirectory()
        ? start.fsPath
        : path.dirname(start.fsPath);
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
function makeScript() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "b6p-routing-"));
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
  fs.writeFileSync(
    path.join(draft, "scripts", "app.ts"),
    'import { Color } from "./enums";\nB.log("c" + Color.Green);\nexport {};\n'
  );
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
  const s = makeScript();
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
const FLOOR = "26.11.16.00";

function assertDraftOnly(r, reason, serverVersion, snapshot) {
  assert.strictEqual(r.error, null, String(r.error && r.error.stack));
  const res = r.result;
  assert.strictEqual(res.pushed, true);
  assert.deepStrictEqual(res.route, { mode: "draft-only", reason, serverVersion, required: res.route.required });
  assert.strictEqual(res.compile, null);
  assert.strictEqual(res.publish, null);
  assert.strictEqual(res.historyRecorded, false);
  assert.deepStrictEqual(sorted(r.puts()), SOURCES, "sources only, to draft/");
  assert.deepStrictEqual(r.gql, [], "no compileDraft, takeSnapshot or history call");
  assert.ok(
    !r.requests.some((q) => /graphql/i.test(q) || q.includes("snapshot/")),
    "nothing but WebDAV to draft/ and the version read"
  );
  if (snapshot) {
    assert.ok(res.snapshotRefused, "a snapshot push reports it took no snapshot");
    assert.strictEqual(res.snapshotRefused.reason, reason === "below-floor" ? "too-old" : reason);
    assert.strictEqual(res.snapshotRefused.serverVersion, serverVersion);
    assert.strictEqual(res.snapshotRefused.required, res.route.required);
    assert.ok(r.warnings.some((w) => /No snapshot was taken/.test(w)));
  } else {
    assert.strictEqual(res.snapshotRefused, null);
  }
}

// -- server route --

test("dev -> server flow: sources to draft/ only, then compileDraft + takeSnapshot + history", async () => {
  const r = await push({ body: "dev" });
  assert.strictEqual(r.error, null, String(r.error && r.error.stack));
  assert.deepStrictEqual(r.result.route, { mode: "server", reason: "dev", serverVersion: "dev", required: FLOOR });
  assert.strictEqual(r.result.snapshotRefused, null);
  assert.deepStrictEqual(sorted(r.puts()), SOURCES);
  assert.deepStrictEqual(r.gql, ["compileDraft", "takeSnapshot", "history"]);
  assert.strictEqual(r.result.compile.status, "COMPILED");
  assert.strictEqual(r.result.publish.published, true);
});

test("at or above the floor -> server flow, plain and snapshot", async () => {
  const s = await push({ body: FLOOR + "\n" });
  assert.strictEqual(s.result.route.reason, "at-or-above-floor");
  assert.deepStrictEqual(s.gql, ["compileDraft", "takeSnapshot", "history"]);
  const p = await push({ body: "26.12.01.00" }, { snapshot: false });
  assert.strictEqual(p.result.route.mode, "server");
  assert.deepStrictEqual(p.gql, ["compileDraft"]);
  assert.strictEqual(p.result.snapshotRefused, null);
});

// -- draft-only route --

test("below the floor, snapshot push -> sources saved to draft/, no GraphQL, snapshotRefused too-old", async () => {
  assertDraftOnly(await push({ body: "26.11.02.05" }), "below-floor", "26.11.02.05", true);
});

test("below the floor, plain push -> the same draft-only upload, nothing refused", async () => {
  const r = await push({ body: "26.11.02.05" }, { snapshot: false });
  assertDraftOnly(r, "below-floor", "26.11.02.05", false);
  assert.strictEqual(r.errors.length, 0);
});

test("unreadable version (404, garbage, network failure) -> draft-only, reason unknown", async () => {
  for (const [answer, seen] of [
    [{ status: 404, body: "no" }, null],
    [{ status: 500 }, null],
    [{ body: "  " }, null],
    [{ body: "banana" }, "banana"],
    [new Error("ECONNRESET"), null],
  ]) {
    assertDraftOnly(await push(answer, { snapshot: false }), "unknown", seen, false);
    assertDraftOnly(await push(answer, { snapshot: true }), "unknown", seen, true);
  }
});

test("floor unset: release tags are draft-only, dev is still the server", async () => {
  assertDraftOnly(await push({ body: "40.01.01.00" }, { floor: null }), "floor-unset", "40.01.01.00", true);
  assertDraftOnly(
    await push({ body: "40.01.01.00" }, { floor: null, snapshot: false }),
    "floor-unset",
    "40.01.01.00",
    false
  );
  const d = await push({ body: "dev" }, { snapshot: false, floor: null });
  assert.strictEqual(d.result.route.mode, "server");
});

test("the shipped floor 26.11.09.00: an older release tag is draft-only and its snapshot refused", async () => {
  const shipped = await push({ body: "26.11.02.04" }, { snapshot: true, floor: undefined });
  assert.strictEqual(shipped.result.route.reason, "below-floor");
  assert.strictEqual(shipped.result.snapshotRefused.reason, "too-old");
  assert.strictEqual(shipped.result.snapshotRefused.required, "26.11.09.00");
});

test("draft-only upload failure rethrows the upload error and makes no compile call", async () => {
  const s = makeScript();
  const h = makeCtx({ body: "26.11.02.05" });
  const realFetch = h.ctx.sessionManager.fetch;
  h.ctx.sessionManager.fetch = async (url, init) =>
    init && init.method === "PUT" && String(url).endsWith("enums.ts")
      ? new Response("no", { status: 500 })
      : realFetch(url, init);
  try {
    await assert.rejects(() =>
      executePush({
        ctx: h.ctx,
        targetUrl: TARGET + "draft",
        rootPath: s.rootPath,
        snapshot: true,
        serverVersionFloor: FLOOR,
      })
    );
    assert.deepStrictEqual(h.gql, []);
  } finally {
    fs.rmSync(s.tmp, { recursive: true, force: true });
  }
});

test("a missing draft folder stops before asking the version; route is null", async () => {
  const h = makeCtx({ body: "dev" });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "b6p-routing-"));
  try {
    const res = await executePush({
      ctx: h.ctx,
      targetUrl: TARGET + "draft",
      rootPath: path.join(tmp, "x"),
      snapshot: true,
    });
    assert.strictEqual(res.pushed, false);
    assert.strictEqual(res.route, null);
    assert.strictEqual(res.snapshotRefused, null);
    assert.deepStrictEqual(h.requests, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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
