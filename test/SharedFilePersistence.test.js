// Behavioral spec for SharedFilePersistence.atomicWrite retry + lock diagnostics.
//
// atomicWrite does write-temp -> fs.rename. On Windows the rename over an open
// target fails transiently with EPERM/EBUSY/EACCES (AV/ransomware protection,
// file sync, an editor, or a second b6p process). This spec pins: transient
// lock errors are retried and succeed; non-lock errno values are rethrown
// immediately; exhausted retries clean up the temp file, preserve the original
// errno, and annotate the message via the best-effort ILockDiagnoser (naming
// holders, or a minifilter hint when the diagnosis completes empty, or a
// generic hint when there is no diagnoser / it fails).
//
// b6p-core has no test framework; this is a minimal, dependency-free node script
// (run via `npm test`) exercising the COMPILED class from dist/. We replace
// fs.rename with a reconfigurable dispatcher to simulate the transient lock.
const assert = require("node:assert");
const os = require("os");
const path = require("path");
const fsp = require("fs/promises");

// Patch fs.rename with a reconfigurable dispatcher BEFORE requiring the compiled
// module, so the swap holds whether tsc copies the namespace (__importStar) or
// references it live. `renameImpl` is what each test configures.
const realRename = fsp.rename.bind(fsp);
let renameImpl = realRename;
fsp.rename = (...args) => renameImpl(...args);

const { SharedFilePersistence } = require("../dist/persistence/SharedFilePersistence.js");

function tmpDir() {
  return path.join(os.tmpdir(), `b6p-sfp-test-${Date.now()}-${Math.floor(Math.random() * 1e9)}`);
}

function errnoError(code) {
  const e = new Error(`${code}: simulated failure`);
  e.code = code;
  e.syscall = "rename";
  return e;
}

/** Throws `code` the first `failCount` calls, then performs the real rename. */
function failThenSucceed(code, failCount) {
  let calls = 0;
  const fn = async (...args) => {
    calls += 1;
    if (calls <= failCount) throw errnoError(code);
    return realRename(...args);
  };
  fn.calls = () => calls;
  return fn;
}

/** Always throws `code`; counts calls. */
function alwaysFail(code) {
  let calls = 0;
  const fn = async () => {
    calls += 1;
    throw errnoError(code);
  };
  fn.calls = () => calls;
  return fn;
}

let failures = 0;
async function test(name, fn) {
  renameImpl = realRename;
  try {
    await fn();
    console.log("ok   -", name);
  } catch (e) {
    failures++;
    console.error("FAIL -", name, "\n     ", e && e.stack ? e.stack : e);
  } finally {
    renameImpl = realRename;
  }
}

(async () => {
  await test("retries a transient EPERM and succeeds (the write lands)", async () => {
    const impl = failThenSucceed("EPERM", 2);
    renameImpl = impl;
    const p = new SharedFilePersistence(tmpDir());
    await p.set("k", { v: 1 });
    assert.strictEqual(impl.calls(), 3, "should fail twice, then succeed on the 3rd attempt");
    assert.deepStrictEqual(await p.get("k"), { v: 1 }, "value should be readable once the write lands");
  });

  await test("rethrows a non-lock errno immediately, without retrying", async () => {
    const impl = alwaysFail("ENOSPC");
    renameImpl = impl;
    const p = new SharedFilePersistence(tmpDir());
    await assert.rejects(
      () => p.set("k", { v: 1 }),
      (e) => e.code === "ENOSPC"
    );
    assert.strictEqual(impl.calls(), 1, "a non-lock errno must not be retried");
  });

  await test("exhausts retries: names holders, preserves errno, cleans up the temp file", async () => {
    const impl = alwaysFail("EBUSY");
    renameImpl = impl;
    const dir = tmpDir();
    const diagnoser = {
      diagnose: async () => [
        { name: "Code.exe", pid: 1234 },
        { name: "OneDrive.exe", pid: 5678 },
      ],
    };
    const p = new SharedFilePersistence(dir, diagnoser);
    let thrown;
    try {
      await p.set("k", { v: 1 });
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown, "should throw after exhausting retries");
    assert.strictEqual(impl.calls(), 7, "should attempt the rename 7 times before giving up");
    assert.strictEqual(thrown.code, "EBUSY", "the original errno must be preserved on the thrown error");
    assert.match(thrown.message, /locked by Code\.exe \(1234\), OneDrive\.exe \(5678\)/);
    const entries = await fsp.readdir(dir).catch(() => []);
    assert.ok(
      !entries.some((f) => f.includes(".tmp.")),
      "the temp file must be cleaned up; saw: " + entries.join(", ")
    );
  });

  await test("exhausted with a diagnoser that finds nothing -> minifilter hint", async () => {
    renameImpl = alwaysFail("EPERM");
    const p = new SharedFilePersistence(tmpDir(), { diagnose: async () => [] });
    await assert.rejects(
      () => p.set("k", { v: 1 }),
      (e) => /filesystem minifilter/.test(e.message) && e.code === "EPERM"
    );
  });

  await test("exhausted with no diagnoser -> generic hint, errno preserved", async () => {
    renameImpl = alwaysFail("EACCES");
    const p = new SharedFilePersistence(tmpDir());
    await assert.rejects(
      () => p.set("k", { v: 1 }),
      (e) => e.code === "EACCES" && /held open by another process/.test(e.message)
    );
  });

  await test("a throwing diagnoser never masks the error; falls back to the generic hint", async () => {
    renameImpl = alwaysFail("EPERM");
    const p = new SharedFilePersistence(tmpDir(), {
      diagnose: async () => {
        throw new Error("Restart Manager unavailable");
      },
    });
    await assert.rejects(
      () => p.set("k", { v: 1 }),
      (e) => e.code === "EPERM" && /held open by another process/.test(e.message)
    );
  });

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll SharedFilePersistence tests passed.");
})();
