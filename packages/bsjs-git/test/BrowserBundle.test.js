// bsjs-git must bundle for a browser with no Node polyfill plugins. The NoNodeBuiltins scan reads only this package's
// own output; this one bundles it WITH isomorphic-git (platform=browser, nothing external), which is where a stray
// `require("buffer")` (safe-buffer) once failed with "Could not resolve buffer". It also runs the bundle's Buffer
// shim in a VM with no Buffer global to prove the shim installs one.

const assert = require("node:assert");
const path = require("node:path");
const vm = require("node:vm");
const esbuild = require("esbuild");

const entry = path.join(__dirname, "..", "dist", "index.js");

let failures = 0;
const pending = [];
function test(name, fn) {
  pending.push([name, fn]);
}

async function bundle() {
  return esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "bsjsGit",
    write: false,
    logLevel: "silent",
  });
}

test("bundles for the browser with no node polyfills and nothing unresolved", async () => {
  const result = await bundle();
  assert.strictEqual(result.errors.length, 0);
  assert.ok(result.outputFiles[0].text.length > 0);
});

test("the bundle runs with no Buffer global and installs one", async () => {
  const result = await bundle();
  const sandbox = { TextDecoder, TextEncoder, URL, URLSearchParams, setTimeout, clearTimeout, console, btoa, atob };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  assert.strictEqual(vm.runInContext("typeof Buffer", sandbox), "undefined");
  vm.runInContext(`${result.outputFiles[0].text}\nglobalThis.__lib = bsjsGit;`, sandbox);
  assert.strictEqual(vm.runInContext("typeof Buffer", sandbox), "function");
  assert.strictEqual(vm.runInContext("typeof __lib.ScriptRepo", sandbox), "function");
});

(async () => {
  for (const [name, fn] of pending) {
    try {
      await fn();
      console.log(`ok   - ${name}`);
    } catch (e) {
      failures++;
      console.error(`FAIL - ${name}\n       ${e.stack || e.message}`);
    }
  }
  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll BrowserBundle tests passed.");
})();
