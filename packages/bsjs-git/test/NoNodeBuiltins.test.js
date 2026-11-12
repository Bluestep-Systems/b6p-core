// bsjs-git must run in a browser: its built output may import no Node built-in module and touch no Node-only global.
// Scans every compiled file in dist/ (the package's own code; the file system is injected, never imported) and the
// package's declared dependencies. Dependency-free node script over the COMPILED output.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { builtinModules } = require("node:module");

const dist = path.join(__dirname, "..", "dist");
const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? files(full) : e.name.endsWith(".js") ? [full] : [];
  });
}

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok   - ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL - ${name}\n       ${e.message}`);
  }
}

const built = files(dist);

test("the build produced output", () => {
  assert.ok(built.length > 0, "dist/ is empty");
});

test("no compiled file imports a node built-in", () => {
  for (const file of built) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(
      /require\(\s*["']([^"']+)["']\s*\)|from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g
    )) {
      const spec = match[1] || match[2] || match[3];
      assert.ok(!builtins.has(spec), `${path.relative(dist, file)} imports the node built-in "${spec}"`);
    }
  }
});

test("no compiled file uses a node-only global", () => {
  for (const file of built) {
    if (path.basename(file) === "bufferShim.js") {
      continue; // the one place that names Buffer: it installs the npm `buffer` package when the global is missing
    }
    const text = fs
      .readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!/\bBuffer\b/.test(text), `${path.relative(dist, file)} uses Buffer`);
    assert.ok(!/\bprocess\.(env|versions|platform|cwd)/.test(text), `${path.relative(dist, file)} uses process`);
    assert.ok(!/__dirname|__filename/.test(text), `${path.relative(dist, file)} uses __dirname/__filename`);
  }
});

test("the runtime dependencies are isomorphic-git and the buffer shim package, pinned exactly", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.deepStrictEqual(Object.keys(pkg.dependencies).sort(), ["buffer", "isomorphic-git"]);
  for (const version of Object.values(pkg.dependencies)) {
    assert.match(version, /^\d+\.\d+\.\d+$/);
  }
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log("\nAll NoNodeBuiltins tests passed.");
