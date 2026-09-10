# Writing tests here

Moved out of the repo's always-on rules (2026-09-10) — this only applies when you are writing a test,
so it lives next to the tests instead of loading in every session.

**There is no test framework.** These are dependency-free node scripts (`node:assert`, `require`) that
`npm test` runs in sequence after a compile. Behavioural specs assert against the **compiled** output
in `dist/`, not `src/`. The one exception is `JsdocLastReviewed.test.js`, a source-level convention
ratchet described in `AGENTS.md`.

**A new test file must be appended to the `test` script in `package.json` by hand.** Nothing globs
this directory, so a file that is not listed there silently never runs.

**What belongs here:** behavioural specs for the pure, high-risk logic that is awkward to reach from a
consumer — integrity auditing, path/URL parsing, URI canonicality and the folder marker, `outDir`
resolution, stale-bundle detection, metadata write coalescing, org-cache load readiness, and the
atomic-write rename retry. Broad integration coverage lives in the consumers (CLI, extension); core
additionally ships vscode-free test doubles (e.g. `MockFileSystem`) for them to use.

## Every spec must pass on Windows and POSIX alike

`B6PUri.test.js` is the pattern to copy: it hardcodes no absolute path and no `file://` literal
embedding one, building every case from `path.parse(process.cwd()).root` + `path.join` and deriving
every expectation from Node's own `pathToFileURL` — so each assertion states a *relationship* rather
than a spelling.

Literals are fine where the code under test is pure URL parsing, which is platform-independent; that
is how a POSIX runner still covers `file:///C:/…` drive-letter hrefs.

`DownstairsPathParser.test.js` shows the other half of the technique — swapping the ambient `path`
members for `path.win32` to drive the Windows branch from a Linux host.
