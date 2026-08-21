// Enforces the AGENTS.md JSDoc review rule: every NEW or MODIFIED JSDoc block
// must carry an `@lastreviewed` tag (`null` until a human reviewer replaces it
// with the review date).
//
// The rule predates most of the codebase — hundreds of pre-rule JSDoc blocks
// have no tag — so a blanket "every block must be tagged" check would either
// fail forever or force a mass retro-tagging commit that would mislabel old
// human-written docs. This is therefore a RATCHET: the checked-in baseline
// (test/jsdoc-lastreviewed.baseline.json) records, per file, how many untagged
// blocks are tolerated. A file may never exceed its baseline (new/edited JSDoc
// without the tag fails CI); files absent from the baseline tolerate zero, so
// every new file must tag everything. When you tag previously-untagged blocks,
// tighten the ratchet by regenerating the baseline:
//
//   node test/JsdocLastReviewed.test.js --update
//
// b6p-core has no test framework; this is a minimal, dependency-free node
// script (run via `npm test`). It reads src/ directly — no compile needed.
const fs = require("fs");
const path = require("path");

const SRC_DIR = path.join(__dirname, "..", "src");
const BASELINE_PATH = path.join(__dirname, "jsdoc-lastreviewed.baseline.json");
const JSDOC_BLOCK = /\/\*\*[\s\S]*?\*\//g;
// A real tag with a value (`null` or a date) — prose that merely mentions the
// word "@lastreviewed" does not count.
const LASTREVIEWED_TAG = /@lastreviewed\s+(null|\d{4}-\d{2}-\d{2})\b/;

function collectCounts() {
  const counts = {};
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".ts")) {
        const source = fs.readFileSync(full, "utf8");
        const blocks = source.match(JSDOC_BLOCK) || [];
        const missing = blocks.filter((b) => !LASTREVIEWED_TAG.test(b)).length;
        if (missing > 0) {
          const rel = path.relative(path.join(__dirname, ".."), full).split(path.sep).join("/");
          counts[rel] = missing;
        }
      }
    }
  })(SRC_DIR);
  return counts;
}

const current = collectCounts();

if (process.argv.includes("--update")) {
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(current, null, 2) + "\n");
  console.log(`Baseline regenerated: ${Object.keys(current).length} file(s) with tolerated untagged blocks.`);
  process.exit(0);
}

const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));

const violations = [];
const improvements = [];
for (const [file, count] of Object.entries(current)) {
  const allowed = baseline[file] ?? 0;
  if (count > allowed) {
    violations.push({ file, allowed, count });
  } else if (count < allowed) {
    improvements.push(file);
  }
}
for (const file of Object.keys(baseline)) {
  if (!(file in current)) {
    improvements.push(file);
  }
}

if (violations.length > 0) {
  console.error("FAIL - JSDoc blocks missing @lastreviewed (new or modified JSDoc must carry the tag):\n");
  for (const { file, allowed, count } of violations) {
    console.error(`  ${file}: ${count} untagged block(s), baseline tolerates ${allowed}`);
  }
  console.error(
    "\nAdd `@lastreviewed null` to the JSDoc you added or modified (a human reviewer replaces null" +
      "\nwith the review date). See AGENTS.md → JSDoc Review Requirement."
  );
  process.exit(1);
}

if (improvements.length > 0) {
  console.log(
    `note - ${improvements.length} file(s) now have fewer untagged JSDoc blocks than the baseline ` +
      `tolerates. Tighten the ratchet: node test/JsdocLastReviewed.test.js --update`
  );
}

console.log("\nAll JsdocLastReviewed checks passed.");
