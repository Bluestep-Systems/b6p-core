// Behavioural spec for B6PUri — the canonicality invariant and the trailing-separator
// folder marker.
//
// b6p-core has no test framework; this is a minimal, dependency-free node script
// (run via `npm test`). It exercises the COMPILED class from dist/.
//
// Two properties are load-bearing here and neither is obvious from the type:
//
//   1. Canonicality. `_href` is stored canonical by BOTH constructors, which is what
//      makes `equals` equality-of-denotation rather than equality-of-spelling, and
//      what makes `toString()` sound as a Map key (MockFileSystem keys on it). When
//      `fromString` stored its argument verbatim, three spellings of one file were
//      three unequal values that keyed apart.
//
//   2. The folder marker. A trailing separator is the ONLY signal ScriptFactory
//      .createNode has for classifying a path as a ScriptFolder rather than a
//      ScriptFile — it cannot touch the filesystem. So `file:///a/b` and
//      `file:///a/b/` denote different things and are CORRECTLY unequal; that
//      inequality is a feature and must not be "fixed" into a normalization.
//
// PLATFORM AGNOSTIC BY CONSTRUCTION. This file must pass on Windows and on POSIX,
// so it hardcodes no absolute path and no `file://` literal that embeds one. Every
// filesystem case is built from `ROOT` + `path.join` and every expectation is derived
// from Node's own `pathToFileURL` — the same primitive B6PUri delegates to — so the
// assertions state a RELATIONSHIP rather than a spelling. On Linux a case reads
// `/ws/...`, on Windows `C:\ws\...`, and the assertion is identical.
//
// Cases that exercise pure URL parsing (no filesystem) DO use literals, including
// `file:///C:/...` drive-letter hrefs: URL parsing is platform-independent, so those
// are the same on both hosts and are the only way to cover a Windows-shaped href from
// a POSIX runner.
const path = require("path");
const assert = require("node:assert");
const { pathToFileURL } = require("url");
const { B6PUri } = require("../dist/B6PUri.js");
const { ScriptFactory } = require("../dist/script/ScriptFactory.js");

// "/" on POSIX, "C:\" (or whichever drive the checkout lives on) on Windows.
const ROOT = path.parse(process.cwd()).root;
/** An absolute, platform-native path from POSIX-ish segments. */
const p = (...segments) => path.join(ROOT, ...segments);
/** The canonical href Node itself would produce for a path — the expectation oracle. */
const href = (fsPath) => pathToFileURL(fsPath).href;

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log("ok   -", name);
  } catch (e) {
    failures++;
    console.error("FAIL -", name, "\n     ", e.message);
  }
}

// ── Canonicality (fromString) ──────────────────────────────────────────

test("fromString canonicalizes percent-encoding: a space-bearing spelling folds onto fromFsPath", () => {
  const spacePath = p("a b");
  const canonical = href(spacePath);
  assert.ok(canonical.includes("%20"), `expected the platform to encode the space: ${canonical}`);
  // The same URI, spelled with a raw space instead of %20.
  const sloppy = canonical.replace(/%20/g, " ");
  assert.strictEqual(B6PUri.fromString(sloppy).toString(), B6PUri.fromFsPath(spacePath).toString());
  assert.ok(B6PUri.fromString(sloppy).equals(B6PUri.fromFsPath(spacePath)), "equals() must see one value");
});

test("fromString canonicalizes the 'localhost' file authority away", () => {
  const spacePath = p("a b");
  const withAuthority = href(spacePath).replace(/^file:\/\//, "file://localhost");
  assert.ok(B6PUri.fromString(withAuthority).equals(B6PUri.fromFsPath(spacePath)));
});

test("fromString rejects a malformed URI at the call site, not at first use", () => {
  // The whole point of parsing eagerly: the throw lands on the mistake rather than
  // on some later .fsPath / .scheme / .joinPath an arbitrary distance downstream.
  // Assert on `code`, not the message: assert.throws matches err.message, and Node's
  // wording ("Invalid URL") is not a stable contract the way the code is.
  assert.throws(
    () => B6PUri.fromString("not a url"),
    (e) => e instanceof TypeError && e.code === "ERR_INVALID_URL"
  );
});

test("fromString is identity on an already-canonical href (the fromString(uri.toString()) round trip)", () => {
  // MockFileSystem.findFiles relies on exactly this.
  const canonical = B6PUri.fromFsPath(p("x", "y.ts"));
  assert.ok(B6PUri.fromString(canonical.toString()).equals(canonical));
});

test("fromString does NOT rescue a Windows path — 'C:\\...' parses as scheme 'c:'", () => {
  // `new URL` accepts far more than it looks; this is why fromFsPath exists and why
  // the JSDoc warns about it. Documented so nobody "fixes" fromFsPath into fromString.
  // Pure URL parsing, so this holds identically on both platforms.
  const wrong = B6PUri.fromString("C:\\Users\\foo");
  assert.strictEqual(wrong.scheme, "c");
  assert.strictEqual(wrong.isFile, false);
});

// ── The folder marker ──────────────────────────────────────────────────

test("a file URI and its directory-marked form are NOT equal (the marker is meaningful)", () => {
  const base = B6PUri.fromFsPath(p("a", "b"));
  assert.ok(!base.equals(base.asDirectory()));
});

test("fromFsPath preserves a trailing platform separator as the marker", () => {
  // pathToFileURL is documented to preserve a trailing separator, using the platform's
  // own sep — so this is the one place the POSIX/Windows difference is asserted directly.
  assert.strictEqual(B6PUri.fromFsPath(p("a", "b") + path.sep).isDirectoryMarked, true);
  assert.strictEqual(B6PUri.fromFsPath(p("a", "b")).isDirectoryMarked, false);
});

test("the marker survives canonicalization through fromString", () => {
  const dirHref = href(p("a", "b")) + "/";
  assert.strictEqual(B6PUri.fromString(dirHref).isDirectoryMarked, true);
  assert.strictEqual(B6PUri.fromString(href(p("a", "b"))).isDirectoryMarked, false);
});

test("isDirectoryMarked is pathname-based, so a query string cannot fool it", () => {
  assert.strictEqual(B6PUri.fromString("https://h/a/?x=1").isDirectoryMarked, true);
  assert.strictEqual(B6PUri.fromString("https://h/a?x=1").isDirectoryMarked, false);
});

test("isDirectoryMarked works on non-file URIs, whose .fsPath would throw", () => {
  const dav = B6PUri.fromString("https://h/dav/dir/");
  assert.throws(
    () => dav.fsPath,
    (e) => e.code === "ERR_INVALID_URL_SCHEME"
  );
  assert.strictEqual(dav.isDirectoryMarked, true);
});

test("isDirectoryMarked reads a Windows-shaped href identically on any host", () => {
  // Literal hrefs on purpose: pure URL parsing, so a POSIX runner can still cover this.
  assert.strictEqual(B6PUri.fromString("file:///C:/a/b/").isDirectoryMarked, true);
  assert.strictEqual(B6PUri.fromString("file:///C:/a/b").isDirectoryMarked, false);
});

// ── asDirectory ────────────────────────────────────────────────────────

test("asDirectory() applies the marker, in both href and platform-native fsPath terms", () => {
  const base = p("a", "b");
  const marked = B6PUri.fromFsPath(base).asDirectory();
  assert.strictEqual(marked.isDirectoryMarked, true);
  assert.strictEqual(marked.toString(), href(base) + "/");
  assert.strictEqual(marked.fsPath, base + path.sep);
});

test("asDirectory() reproduces the joinPath('/') idiom it replaced at the four migrated sites", () => {
  // ScriptRoot (x2) / ScriptFolder.flattenDirectory / push.ts all used to hand-roll this.
  const base = B6PUri.fromFsPath(p("a", "b"));
  assert.strictEqual(base.asDirectory().toString(), base.joinPath("/").toString());
});

test("asDirectory() is idempotent and returns `this` when already marked", () => {
  const already = B6PUri.fromFsPath(p("a", "b")).asDirectory();
  assert.strictEqual(already.asDirectory(), already, "must not allocate when already marked");
  assert.strictEqual(already.asDirectory().asDirectory().toString(), already.toString());
});

test("asDirectory() preserves query and fragment (an href append would corrupt them)", () => {
  assert.strictEqual(B6PUri.fromString("https://h/a?x=1#f").asDirectory().toString(), "https://h/a/?x=1#f");
});

// ── dirname ────────────────────────────────────────────────────────────

test("dirname() does NOT carry the folder marker", () => {
  // An intermediate revision of 0.5.0 marked it, reasoning that a parent is a
  // directory in every case. That broke the stale-client-bundle push warning:
  // TsConfig.folder() is built from dirname, so findStaleClientBundles began
  // emitting a marker-terminated sourceRoot, and selectStaleBundles' containment
  // test (path.normalize, which PRESERVES a trailing separator) matched nothing.
  // See test/StaleClientBundles.test.js. A caller that wants the marked spelling
  // asks for it with .asDirectory(); the misclassification the marker guarded
  // against is unreachable, since every dirname call site either calls
  // createFolder explicitly or takes .fsPath.
  const child = B6PUri.fromFsPath(p("a", "b", "c.ts"));
  assert.strictEqual(child.dirname.isDirectoryMarked, false);
  assert.strictEqual(child.dirname.toString(), href(p("a", "b")));
  assert.strictEqual(child.dirname.asDirectory().toString(), href(p("a", "b")) + "/", "the marker is opt-in");
});

test("dirname() is marker-insensitive on its input: a file and its folder share a parent", () => {
  const asFile = B6PUri.fromFsPath(p("a", "b"));
  assert.strictEqual(asFile.dirname.toString(), asFile.asDirectory().dirname.toString());
});

test("dirname() is stable at the filesystem root rather than escaping it", () => {
  const top = B6PUri.fromFsPath(p("a"));
  // The root's href ends in "/" because the root IS "/" — not because dirname marked it.
  assert.strictEqual(top.dirname.toString(), href(ROOT));
  assert.strictEqual(top.dirname.dirname.toString(), top.dirname.toString(), "root is a fixed point");
});

test("dirname() is unmarked on non-file URIs too", () => {
  assert.strictEqual(B6PUri.fromString("https://h/dav/dir/file.txt").dirname.toString(), "https://h/dav/dir");
});

test("stripDirectoryMarker collapses both spellings of a directory", () => {
  const dir = href(p("a", "b"));
  assert.strictEqual(B6PUri.stripDirectoryMarker(dir + "/"), B6PUri.stripDirectoryMarker(dir));
  assert.strictEqual(B6PUri.stripDirectoryMarker(p("a", "b") + path.sep), p("a", "b"));
});

test("stripDirectoryMarker treats / and \\ alike on EVERY host", () => {
  // Must not consult path.sep. These helpers are exercised against Windows-shaped
  // input from POSIX hosts (see DownstairsPathParser.test.js driving path.win32), so
  // recognising only the host's own separator makes the comparison host-dependent.
  assert.strictEqual(B6PUri.stripDirectoryMarker("C:\\a\\b\\"), "C:\\a\\b");
  assert.strictEqual(B6PUri.stripDirectoryMarker("/a/b/"), "/a/b");
  assert.strictEqual(B6PUri.stripDirectoryMarker("\\\\srv\\share\\"), "\\\\srv\\share");
});

test("stripDirectoryMarker preserves roots rather than trimming them away", () => {
  // A root trimmed of its separator denotes something else: C: is drive-RELATIVE,
  // not the drive root, and file:///C: likewise.
  assert.strictEqual(B6PUri.stripDirectoryMarker("/"), "/");
  assert.strictEqual(B6PUri.stripDirectoryMarker("C:\\"), "C:\\");
  assert.strictEqual(B6PUri.stripDirectoryMarker("C:/"), "C:/");
  assert.strictEqual(B6PUri.stripDirectoryMarker("file:///C:/"), "file:///C:/");
  assert.strictEqual(B6PUri.stripDirectoryMarker("https://h/"), "https://h/");
});

test("stripDirectoryMarker strips a URL's pathname, keeping query and fragment", () => {
  // asDirectory() deliberately preserves query/fragment, so the marked spelling of a
  // URL with a query does NOT end in a separator. A plain trailing-character trim
  // would leave it untouched and silently key it apart from its unmarked twin.
  const u = B6PUri.fromString("https://h/a?x=1#f");
  assert.strictEqual(u.asDirectory().toString(), "https://h/a/?x=1#f", "sanity: the marker goes on the path");
  assert.strictEqual(
    B6PUri.stripDirectoryMarker(u.asDirectory().toString()),
    B6PUri.stripDirectoryMarker(u.toString()),
    "both spellings of one directory must key alike even with a query"
  );
  assert.strictEqual(B6PUri.stripDirectoryMarker("https://h/a/?x=1"), "https://h/a?x=1");
});

// ── The couplings that make the marker load-bearing ────────────────────

test("isDirectoryMarked agrees with ScriptFactory.createNode's file/folder classification", () => {
  // If these two ever disagree, a directory silently becomes a ScriptFile.
  // The extensionless "README" case is called out in createNode's own JSDoc.
  const factory = new ScriptFactory({});
  const draft = ["ws", "U123456", "MyScript", "draft"];
  const cases = [
    [p(...draft, "file.js"), "ScriptFile"],
    [p(...draft, "sub") + path.sep, "ScriptFolder"],
    [p(...draft, "README"), "ScriptFile"],
  ];
  for (const [fsPath, expectedKind] of cases) {
    const uri = B6PUri.fromFsPath(fsPath);
    const kind = factory.createNode(uri).constructor.name;
    assert.strictEqual(kind, expectedKind, fsPath);
    assert.strictEqual(uri.isDirectoryMarked, kind === "ScriptFolder", fsPath);
  }
});

test("REGRESSION: a marked folder still contains its children (ScriptFolder.contains)", () => {
  // ScriptRoot.getAsFolder() yields a MARKED uri, and it is the receiver in both
  // createFamilial guards. contains() built its prefix as `thisPath + path.sep`, which
  // on a marked path doubled the separator ("/a/b/" + "/" = "/a/b//") and matched no
  // child at all — so every createFamilial call threw "not a sibling".
  const factory = new ScriptFactory({});
  const childPath = p("ws", "U123456", "MyScript", "draft", "file.js");
  const root = factory.createFile(B6PUri.fromFsPath(childPath)).getScriptRoot();
  const asFolder = root.getAsFolder();

  assert.strictEqual(asFolder.uri().isDirectoryMarked, true, "precondition: the root folder is marked");
  assert.ok(asFolder.contains(B6PUri.fromFsPath(childPath)), "must contain a genuine child");
  assert.ok(asFolder.contains(asFolder.uri()), "must contain itself");
  assert.ok(asFolder.contains(root.getRootUri()), "marked and unmarked spellings of itself agree");
  assert.ok(
    !asFolder.contains(B6PUri.fromFsPath(p("ws", "U123456", "MyScriptOther", "draft", "file.js"))),
    "must not contain a sibling whose path merely shares a prefix"
  );
});

test("createFamilial accepts a genuine sibling now that containment works", () => {
  const factory = new ScriptFactory({});
  const draft = ["ws", "U123456", "MyScript", "draft"];
  const file = factory.createFile(B6PUri.fromFsPath(p(...draft, "file.js")));
  const sibling = file.createFamilial(B6PUri.fromFsPath(p(...draft, "other.js")));
  assert.strictEqual(sibling.constructor.name, "ScriptFile");
  assert.throws(
    () => file.createFamilial(B6PUri.fromFsPath(p("elsewhere", "U999999", "Nope", "draft", "x.js"))),
    /not a proper sibling/
  );
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log("\nAll B6PUri tests passed.");
