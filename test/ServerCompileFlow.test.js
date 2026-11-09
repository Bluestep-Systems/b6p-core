// The push flow on the server compile (rulings 41-43, ClickUp 86bczwj62; web contract Revision 4,
// section 2.4): PUT sources to draft/ -> GraphQL `compileDraft` -> (snapshot push, compile left
// something to publish) GraphQL `takeSnapshot`. Core never PUTs `snapshot/` or `.build`.
//
// Dependency-free; runs the COMPILED functions from dist/ against fakes: a scripted `csrfFetch`
// that answers each mutation from a queue, a recording sleep (so retries cost nothing) and fake
// files whose upload() records the order of events.

const assert = require("node:assert");
const { Err } = require("../dist/Err.js");
const {
  compileDraft,
  takeSnapshot,
  compileAllowsPublish,
  parseDraftCompileOutcome,
  COMPILE_RETRY,
  KNOWN_DRAFT_COMPILE_STATUSES,
} = require("../dist/script/ServerCompile.js");
const { uploadAndCompile } = require("../dist/script/push.js");

let failures = 0;
const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const noop = () => {};

/** A compileDraft answer: one `bluestepCompile` element. */
function compiled(status, extra = {}) {
  return {
    extensions: {
      bluestepCompile: [
        {
          script: "363769___1",
          status,
          errors: 0,
          warnings: 0,
          written: 2,
          deleted: 0,
          diagnostics: [],
          diagnosticsOmitted: 0,
          ...extra,
        },
      ],
    },
  };
}
const published = () => ({
  extensions: {
    bluestepPublish: [
      {
        script: "363769___1",
        published: true,
        written: 3,
        deleted: 1,
        errors: 0,
        warnings: 1,
        diagnostics: [],
        diagnosticsOmitted: 0,
      },
    ],
  },
});
/** A takeSnapshot answer refusing with `reason`, carrying `publish` detail; the message misleads on purpose. */
function refused(reason, publish = {}) {
  return {
    errors: [
      {
        message: "something unrelated: GATE_TRIPPED",
        extensions: {
          code: "PUBLISH_REFUSED",
          reason,
          publish: {
            published: false,
            written: 0,
            deleted: 0,
            errors: 1,
            warnings: 0,
            diagnostics: [],
            diagnosticsOmitted: 0,
            withheld: [],
            ...publish,
          },
        },
      },
    ],
  };
}

/**
 * A scripted platform. `answers` maps an action to a queue of answers: a JSON body (returned as 200),
 * an Error (thrown, a network failure) or `{ status }` (an HTTP status with no body).
 */
function makeTarget(answers, events = []) {
  const queues = { compileDraft: [...(answers.compileDraft || [])], takeSnapshot: [...(answers.takeSnapshot || [])] };
  const calls = [];
  const sleeps = [];
  const target = {
    ctx: {
      logger: { debug: noop, info: noop, warn: noop, error: noop },
      sessionManager: {
        csrfFetch: async (url, init) => {
          const sent = JSON.parse(init.body);
          const input = sent.variables.inputs[0];
          const action = input.compileDraft ? "compileDraft" : input.takeSnapshot ? "takeSnapshot" : "other";
          calls.push({ url: String(url), query: sent.query, input, action });
          events.push(action);
          const next = queues[action].shift();
          if (next === undefined) {
            throw new Error(`unscripted ${action} call`);
          }
          if (next instanceof Error) {
            throw next;
          }
          if (typeof next.status === "number" && !next.extensions && !next.errors) {
            return new Response("gateway", { status: next.status });
          }
          return new Response(JSON.stringify(next), { status: 200 });
        },
      },
    },
    getScriptKey: async () => ({
      classid: "363769",
      mutationName: "updateScriptEndpoint",
      inputType: "UpdateScriptEndpointInput",
      toCompoundId: () => "363769___1",
    }),
    anyOrigin: async () => new URL("https://org.bluestep.net/"),
  };
  const sleep = async (ms) => {
    sleeps.push(ms);
  };
  return { target, calls, sleeps, sleep, events };
}

// ── compileDraft: request shape and outcome ──
test("compileDraft sends the script type's update mutation with { compileDraft: true } to /gql", async () => {
  const { target, calls, sleep } = makeTarget({ compileDraft: [compiled("COMPILED")] });
  const outcome = await compileDraft(target, { sleep });
  assert.strictEqual(outcome.status, "COMPILED");
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, "https://org.bluestep.net/gql");
  assert.match(calls[0].query, /updateScriptEndpoint\(inputs: \$inputs\)/);
  assert.match(calls[0].query, /\[UpdateScriptEndpointInput!\]/);
  assert.deepStrictEqual(calls[0].input, { topId: "363769___1", compileDraft: true });
});

test("the outcome carries counts, diagnostics, omitted count and the gate block", () => {
  const o = parseDraftCompileOutcome({
    script: "x",
    status: "GATE_TRIPPED",
    errors: 1,
    warnings: 2,
    written: 4,
    deleted: 5,
    diagnostics: [
      {
        origin: "TYPESCRIPT",
        severity: "ERROR",
        code: 2304,
        file: "scripts/app.ts",
        line: 3,
        column: 7,
        message: "nope",
      },
    ],
    diagnosticsOmitted: 9,
    gate: {
      tripped: true,
      withheld: ["tsconfig.json"],
      checked: 6,
      problems: [
        {
          kind: "OUTPUT_DIFFERS",
          tsconfig: "tsconfig.json",
          file: "scripts/a.ts",
          message: "differs",
          diff: "-a\n+b",
          accepted: false,
        },
      ],
      problemsOmitted: 2,
    },
  });
  assert.strictEqual(o.status, "GATE_TRIPPED");
  assert.deepStrictEqual([o.errors, o.warnings, o.written, o.deleted, o.diagnosticsOmitted], [1, 2, 4, 5, 9]);
  assert.deepStrictEqual(o.diagnostics, [
    {
      origin: "TYPESCRIPT",
      severity: "ERROR",
      code: 2304,
      file: "scripts/app.ts",
      line: 3,
      column: 7,
      message: "nope",
    },
  ]);
  assert.strictEqual(o.gate.tripped, true);
  assert.deepStrictEqual(o.gate.withheld, ["tsconfig.json"]);
  assert.strictEqual(o.gate.checked, 6);
  assert.strictEqual(o.gate.problemsOmitted, 2);
  assert.deepStrictEqual(o.gate.problems[0], {
    kind: "OUTPUT_DIFFERS",
    tsconfig: "tsconfig.json",
    file: "scripts/a.ts",
    message: "differs",
    diff: "-a\n+b",
    accepted: false,
  });
});

test("an unknown status is UNKNOWN and keeps the raw string; no gate block is undefined", () => {
  const o = parseDraftCompileOutcome({ status: "SOMETHING_NEW" });
  assert.strictEqual(o.status, "UNKNOWN");
  assert.strictEqual(o.rawStatus, "SOMETHING_NEW");
  assert.strictEqual(o.gate, undefined);
  assert.strictEqual(parseDraftCompileOutcome(undefined).status, "UNKNOWN");
});

test("every contract status parses to itself; only three allow a publish", () => {
  assert.strictEqual(KNOWN_DRAFT_COMPILE_STATUSES.length, 12);
  for (const status of KNOWN_DRAFT_COMPILE_STATUSES) {
    const o = parseDraftCompileOutcome({ status });
    assert.strictEqual(o.status, status);
    assert.strictEqual(o.rawStatus, status);
    assert.strictEqual(
      compileAllowsPublish(o.status),
      ["COMPILED", "NOTHING_TO_COMPILE", "SKIPPED_EXTERNALLY_BUILT"].includes(status),
      status
    );
  }
  assert.strictEqual(compileAllowsPublish("UNKNOWN"), false);
});

// ── retries ──
test("BUSY is retried 3 times, 5 s apart, then reported", async () => {
  const busy = compiled("BUSY");
  const { target, calls, sleeps, sleep } = makeTarget({ compileDraft: [busy, busy, busy, busy, compiled("COMPILED")] });
  const outcome = await compileDraft(target, { sleep });
  assert.strictEqual(outcome.status, "BUSY");
  assert.strictEqual(calls.length, 4);
  assert.deepStrictEqual(sleeps, [5_000, 5_000, 5_000]);
});

test("BUSY then COMPILED stops retrying", async () => {
  const { target, calls, sleeps, sleep } = makeTarget({ compileDraft: [compiled("BUSY"), compiled("COMPILED")] });
  assert.strictEqual((await compileDraft(target, { sleep })).status, "COMPILED");
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(sleeps, [5_000]);
});

test("INPUT_INCOMPLETE is retried 3 times, 2 s apart, then reported", async () => {
  const pending = compiled("INPUT_INCOMPLETE");
  const { target, calls, sleeps, sleep } = makeTarget({ compileDraft: [pending, pending, pending, pending] });
  assert.strictEqual((await compileDraft(target, { sleep })).status, "INPUT_INCOMPLETE");
  assert.strictEqual(calls.length, 4);
  assert.deepStrictEqual(sleeps, [2_000, 2_000, 2_000]);
});

test("COMPILER_UNAVAILABLE is retried once", async () => {
  const down = compiled("COMPILER_UNAVAILABLE");
  const { target, calls, sleep } = makeTarget({ compileDraft: [down, down, compiled("COMPILED")] });
  assert.strictEqual((await compileDraft(target, { sleep })).status, "COMPILER_UNAVAILABLE");
  assert.strictEqual(calls.length, 2);
  const again = makeTarget({ compileDraft: [down, compiled("COMPILED")] });
  assert.strictEqual((await compileDraft(again.target, { sleep: again.sleep })).status, "COMPILED");
});

test("the retry budgets are separate per kind", async () => {
  const { target, calls, sleeps, sleep } = makeTarget({
    compileDraft: [compiled("BUSY"), compiled("INPUT_INCOMPLETE"), compiled("BUSY"), compiled("COMPILED")],
  });
  assert.strictEqual((await compileDraft(target, { sleep })).status, "COMPILED");
  assert.strictEqual(calls.length, 4);
  assert.deepStrictEqual(sleeps, [5_000, 2_000, 5_000]);
});

test("statuses that need the author are never retried: GATE_TRIPPED, EMIT_WITHHELD, WRITE_FAILED, NOT_PERMITTED", async () => {
  for (const status of ["GATE_TRIPPED", "EMIT_WITHHELD", "WRITE_FAILED", "NOT_PERMITTED", "NOTHING_TO_COMPILE"]) {
    const { target, calls, sleeps, sleep } = makeTarget({ compileDraft: [compiled(status), compiled("COMPILED")] });
    assert.strictEqual((await compileDraft(target, { sleep })).status, status);
    assert.strictEqual(calls.length, 1, status);
    assert.deepStrictEqual(sleeps, []);
  }
});

test("a network failure is retried once; twice is a ServerCompileRequestError", async () => {
  const ok = makeTarget({ compileDraft: [new Error("ECONNRESET"), compiled("COMPILED")] });
  assert.strictEqual((await compileDraft(ok.target, { sleep: ok.sleep })).status, "COMPILED");
  assert.strictEqual(ok.calls.length, 2);
  assert.deepStrictEqual(ok.sleeps, [COMPILE_RETRY.NETWORK.delayMs]);

  const bad = makeTarget({ compileDraft: [new Error("ECONNRESET"), { status: 502 }] });
  await assert.rejects(
    () => compileDraft(bad.target, { sleep: bad.sleep }),
    (e) => e instanceof Err.ServerCompileRequestError && e.phase === "compile" && e.networkFailure === true
  );
  assert.strictEqual(bad.calls.length, 2);
});

test("a GraphQL error on compileDraft (not permitted) is a ServerCompileRequestError, not retried", async () => {
  const { target, calls, sleep } = makeTarget({
    compileDraft: [{ errors: [{ message: "You may not edit this script", extensions: { code: "FORBIDDEN" } }] }],
  });
  await assert.rejects(
    () => compileDraft(target, { sleep }),
    (e) =>
      e instanceof Err.ServerCompileRequestError &&
      e.phase === "compile" &&
      e.networkFailure === false &&
      e.messages[0] === "You may not edit this script"
  );
  assert.strictEqual(calls.length, 1);
});

// ── takeSnapshot ──
test("takeSnapshot sends { takeSnapshot: true } and reads extensions.bluestepPublish", async () => {
  const { target, calls, sleep } = makeTarget({ takeSnapshot: [published()] });
  const outcome = await takeSnapshot(target, { sleep });
  assert.deepStrictEqual(calls[0].input, { topId: "363769___1", takeSnapshot: true });
  assert.strictEqual(outcome.published, true);
  assert.deepStrictEqual([outcome.written, outcome.deleted, outcome.warnings], [3, 1, 1]);
});

test("PUBLISH_REFUSED throws PublishRefusedError with reason and publish detail, never from the message", async () => {
  const { target, sleep } = makeTarget({
    takeSnapshot: [refused("ENTRYPOINT_MISSING", { entrypoint: "scripts/app.js", withheld: ["tsconfig.json"] })],
  });
  await assert.rejects(
    () => takeSnapshot(target, { sleep }),
    (e) =>
      e instanceof Err.PublishRefusedError &&
      e.reason === "ENTRYPOINT_MISSING" &&
      e.rawReason === "ENTRYPOINT_MISSING" &&
      e.publish.published === false &&
      e.publish.entrypoint === "scripts/app.js" &&
      e.publish.withheld[0] === "tsconfig.json"
  );
});

test("all nine refusal reasons arrive as themselves; an unknown one is UNKNOWN with the raw text", async () => {
  for (const reason of [
    "GATE_TRIPPED",
    "EMIT_WITHHELD",
    "ENTRYPOINT_MISSING",
    "OUTPUT_SHADOWS",
    "COMPILER_UNAVAILABLE",
    "WRITE_FAILED",
    "NOT_PERMITTED",
  ]) {
    const { target, calls, sleep } = makeTarget({ takeSnapshot: [refused(reason)] });
    await assert.rejects(
      () => takeSnapshot(target, { sleep }),
      (e) => e instanceof Err.PublishRefusedError && e.reason === reason
    );
    assert.strictEqual(calls.length, 1, `${reason} must not be retried`);
  }
  const { target, sleep } = makeTarget({ takeSnapshot: [refused("BRAND_NEW")] });
  await assert.rejects(
    () => takeSnapshot(target, { sleep }),
    (e) => e instanceof Err.PublishRefusedError && e.reason === "UNKNOWN" && e.rawReason === "BRAND_NEW"
  );
});

test("a BUSY publish refusal is retried (3 x 5 s), INPUT_INCOMPLETE too (3 x 2 s), then thrown", async () => {
  const busy = makeTarget({ takeSnapshot: [refused("BUSY"), refused("BUSY"), published()] });
  assert.strictEqual((await takeSnapshot(busy.target, { sleep: busy.sleep })).published, true);
  assert.deepStrictEqual(busy.sleeps, [5_000, 5_000]);

  const exhausted = makeTarget({ takeSnapshot: [refused("BUSY"), refused("BUSY"), refused("BUSY"), refused("BUSY")] });
  await assert.rejects(
    () => takeSnapshot(exhausted.target, { sleep: exhausted.sleep }),
    (e) => e instanceof Err.PublishRefusedError && e.reason === "BUSY"
  );
  assert.strictEqual(exhausted.calls.length, 4);

  const pending = makeTarget({ takeSnapshot: [refused("INPUT_INCOMPLETE"), published()] });
  await takeSnapshot(pending.target, { sleep: pending.sleep });
  assert.deepStrictEqual(pending.sleeps, [2_000]);
});

test("a GraphQL error that is not a publish refusal is a ServerCompileRequestError (phase publish)", async () => {
  const { target, sleep } = makeTarget({
    takeSnapshot: [{ errors: [{ message: "boom", extensions: { code: "INTERNAL" } }] }],
  });
  await assert.rejects(
    () => takeSnapshot(target, { sleep }),
    (e) => e instanceof Err.ServerCompileRequestError && e.phase === "publish"
  );
});

// ── the push flow: uploads, then compileDraft, then takeSnapshot ──
function makeFiles(names, events, failAt) {
  const confirmed = new Set();
  const entries = names.map((name, i) => {
    const file = {
      upload: async () => {
        if (i === failAt) {
          events.push(`PUT ${name} (refused)`);
          throw new Err.FileSendError(`status: 500 ${name}`);
        }
        events.push(`PUT ${name}`);
        return new Response(null, { status: 204 });
      },
    };
    return { filePath: `/ws/${name}`, file };
  });
  return { entries, confirmed };
}
// A progress runner that, like the worst real one, keeps going after a failure and rethrows at the end.
const progress = {
  withProgress: async (tasks) => {
    let first;
    const results = [];
    for (const task of tasks) {
      try {
        results.push(await task.execute());
      } catch (e) {
        first = first ?? e;
      }
    }
    if (first) {
      throw first;
    }
    return results;
  },
};

async function pushFlow({ answers, snapshot, names = ["a.ts", "b.ts"], failAt, afterUpload }) {
  const events = [];
  const platform = makeTarget(answers, events);
  const { entries, confirmed } = makeFiles(names, events, failAt);
  let error = null;
  let result = null;
  try {
    result = await uploadAndCompile({
      ctx: { logger: platform.target.ctx.logger, progress },
      scriptRoot: platform.target,
      entries,
      confirmed,
      snapshot,
      afterUpload: afterUpload ? () => afterUpload(events) : undefined,
      sleep: platform.sleep,
    });
  } catch (e) {
    error = e;
  }
  return { events, error, result, ...platform };
}

test("plain push: every PUT, then exactly one compileDraft, no takeSnapshot", async () => {
  const r = await pushFlow({ answers: { compileDraft: [compiled("COMPILED")] }, snapshot: false });
  assert.strictEqual(r.error, null);
  assert.deepStrictEqual(r.events, ["PUT a.ts", "PUT b.ts", "compileDraft"]);
  assert.strictEqual(r.result.compile.status, "COMPILED");
  assert.strictEqual(r.result.publish, null);
  assert.strictEqual(r.result.written, 2);
});

test("a plain push never publishes, whatever the compile status", async () => {
  for (const status of KNOWN_DRAFT_COMPILE_STATUSES) {
    if (["BUSY", "INPUT_INCOMPLETE", "COMPILER_UNAVAILABLE"].includes(status)) {
      continue; // retried; covered above
    }
    const r = await pushFlow({ answers: { compileDraft: [compiled(status)] }, snapshot: false });
    assert.strictEqual(r.result.compile.status, status);
    assert.strictEqual(r.calls.filter((c) => c.action === "takeSnapshot").length, 0);
  }
});

test("snapshot push: PUTs, compileDraft, then takeSnapshot", async () => {
  const r = await pushFlow({
    answers: { compileDraft: [compiled("COMPILED")], takeSnapshot: [published()] },
    snapshot: true,
  });
  assert.deepStrictEqual(r.events, ["PUT a.ts", "PUT b.ts", "compileDraft", "takeSnapshot"]);
  assert.strictEqual(r.result.compile.status, "COMPILED");
  assert.strictEqual(r.result.publish.published, true);
});

test("snapshot push publishes after NOTHING_TO_COMPILE and SKIPPED_EXTERNALLY_BUILT", async () => {
  for (const status of ["NOTHING_TO_COMPILE", "SKIPPED_EXTERNALLY_BUILT"]) {
    const r = await pushFlow({
      answers: { compileDraft: [compiled(status)], takeSnapshot: [published()] },
      snapshot: true,
    });
    assert.deepStrictEqual(r.events.slice(-2), ["compileDraft", "takeSnapshot"], status);
    assert.strictEqual(r.result.publish.published, true);
  }
});

test("snapshot push with GATE_TRIPPED returns the problems as a result and publishes nothing", async () => {
  const gate = {
    tripped: true,
    withheld: ["tsconfig.json"],
    checked: 3,
    problems: [{ kind: "CONFIG_BROKEN", tsconfig: "tsconfig.json", message: "cannot read", accepted: false }],
    problemsOmitted: 0,
  };
  const r = await pushFlow({ answers: { compileDraft: [compiled("GATE_TRIPPED", { gate })] }, snapshot: true });
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.result.compile.status, "GATE_TRIPPED");
  assert.strictEqual(r.result.compile.gate.problems[0].kind, "CONFIG_BROKEN");
  assert.strictEqual(r.result.publish, null);
  assert.deepStrictEqual(r.events, ["PUT a.ts", "PUT b.ts", "compileDraft"]);
});

test("snapshot push with EMIT_WITHHELD or a failed compile publishes nothing and does not throw", async () => {
  for (const status of ["EMIT_WITHHELD", "WRITE_FAILED", "NOT_PERMITTED", "SKIPPED_GIT_MANAGED", "OUTPUT_UPLOAD"]) {
    const r = await pushFlow({ answers: { compileDraft: [compiled(status, { errors: 1 })] }, snapshot: true });
    assert.strictEqual(r.error, null, status);
    assert.strictEqual(r.result.publish, null, status);
    assert.strictEqual(r.calls.filter((c) => c.action === "takeSnapshot").length, 0, status);
  }
});

test("a refused publish after a good compile throws PublishRefusedError (the compile was committed)", async () => {
  const r = await pushFlow({
    answers: { compileDraft: [compiled("COMPILED")], takeSnapshot: [refused("OUTPUT_SHADOWS")] },
    snapshot: true,
  });
  assert.ok(r.error instanceof Err.PublishRefusedError);
  assert.strictEqual(r.error.reason, "OUTPUT_SHADOWS");
});

test("BUSY compile retries inside the flow with the fake sleep", async () => {
  const r = await pushFlow({
    answers: { compileDraft: [compiled("BUSY"), compiled("BUSY"), compiled("COMPILED")] },
    snapshot: false,
  });
  assert.strictEqual(r.result.compile.status, "COMPILED");
  assert.deepStrictEqual(r.sleeps, [5_000, 5_000]);
  assert.strictEqual(r.calls.length, 3);
});

test("a failed PUT stops uploading, still sends compileDraft, then throws the PUT error", async () => {
  const r = await pushFlow({
    answers: { compileDraft: [compiled("COMPILED")], takeSnapshot: [published()] },
    snapshot: true,
    names: ["a.ts", "b.ts", "c.ts"],
    failAt: 1,
  });
  assert.ok(r.error instanceof Err.FileSendError);
  assert.deepStrictEqual(r.events, ["PUT a.ts", "PUT b.ts (refused)", "compileDraft"]);
  assert.strictEqual(r.calls.filter((c) => c.action === "takeSnapshot").length, 0);
});

test("a PUT that fails before any file went up sends no compileDraft", async () => {
  const r = await pushFlow({ answers: {}, snapshot: false, names: ["a.ts", "b.ts"], failAt: 0 });
  assert.ok(r.error instanceof Err.FileSendError);
  assert.deepStrictEqual(r.events, ["PUT a.ts (refused)"]);
});

test("a compile that also fails after a failed PUT does not hide the PUT error", async () => {
  const r = await pushFlow({
    answers: { compileDraft: [new Error("down"), new Error("down")] },
    snapshot: false,
    names: ["a.ts", "b.ts"],
    failAt: 1,
  });
  assert.ok(r.error instanceof Err.FileSendError);
});

test("afterUpload (platform-only cleanup) runs after the PUTs and before the compile", async () => {
  let ran = 0;
  const r = await pushFlow({
    answers: { compileDraft: [compiled("COMPILED")] },
    snapshot: false,
    afterUpload: async (events) => {
      ran++;
      events.push("cleanup");
      return ["kept.ts"];
    },
  });
  assert.strictEqual(ran, 1);
  assert.deepStrictEqual(r.result.afterUpload, ["kept.ts"]);
  assert.deepStrictEqual(r.events, ["PUT a.ts", "PUT b.ts", "cleanup", "compileDraft"]);
});

test("afterUpload does not run when an upload failed", async () => {
  let ran = 0;
  await pushFlow({
    answers: { compileDraft: [compiled("COMPILED")] },
    snapshot: false,
    failAt: 1,
    afterUpload: async () => {
      ran++;
    },
  });
  assert.strictEqual(ran, 0);
});

test("nothing is ever requested from snapshot/ or .build: the flow's only requests are two GraphQL actions", async () => {
  const r = await pushFlow({
    answers: { compileDraft: [compiled("COMPILED")], takeSnapshot: [published()] },
    snapshot: true,
  });
  assert.deepStrictEqual([...new Set(r.calls.map((c) => c.url))], ["https://org.bluestep.net/gql"]);
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
