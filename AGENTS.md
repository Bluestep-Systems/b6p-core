# AI Agent Guidelines

## Overview

This repository is the **single-package library** `@bluestep-systems/b6p-core` — the vscode-free core
shared by the `b6p` CLI and the VS Code extension (each in its own repo, depending on this package by
version). The public API surface is [src/index.ts](src/index.ts); the headless orchestrator is
[src/B6PCore.ts](src/B6PCore.ts).

Hard constraints for this repo:

- **No `vscode` imports.** Platform behaviour is delegated to the provider interfaces in
  [src/providers.ts](src/providers.ts). A `vscode` import breaks the CLI build and the package's purpose.
- **New exported symbols MUST be added to `src/index.ts`.** That file defines what consumers can import.
- **Never use `any`.** If it appears unavoidable, leave a `//HUMAN-REVIEW-NEEDED` comment explaining the
  situation. If a human reviewer later accepts `any`, they add a `//REASON-FOR-ANY` comment.

## Required Documentation Updates

When you change code, keep the docs in sync in the **same change**:

| File | Purpose | Update when |
|------|---------|-------------|
| `README.md` | User/consumer-facing docs | Public API, install, or usage changes |
| `CLAUDE.md` | Developer/agent guide | Architecture, subsystem, or workflow changes |
| `AGENTS.md` | AI agent rules (this file) | Conventions or process changes |
| `CHANGELOG.md` | Version history | Any user-visible change, fix, or breaking change |

**Never leave documentation outdated** — it is worse than no documentation. If uncertain, leave a
`//HUMAN-REVIEW-NEEDED` note.

## Documentation Quality Standards

- **Be specific**: include file paths, class names, and method signatures.
- **Be actionable**: provide concrete examples.
- **Be current**: remove outdated information when you change behaviour.
- **Be consistent**: use the same terminology across all docs.

## JSDoc Review Requirement

All AI-generated or AI-modified JSDoc **MUST** include the `@lastreviewed null` flag. A human reviewer
replaces `null` with the review date after verifying accuracy. Modifying an already-reviewed JSDoc
block resets its tag to `null` — the old review date does not cover the new text.

The rule is **partially enforced by CI** as a ratchet: `test/JsdocLastReviewed.test.js` (part of
`npm test`) fails when any file gains **net-new untagged** JSDoc blocks beyond the tolerated count in
`test/jsdoc-lastreviewed.baseline.json` (pre-rule blocks are grandfathered there; new files tolerate
zero). Be precise about what that does and does not catch:

- **Caught**: adding a JSDoc block without a well-formed `@lastreviewed null`/date tag.
- **Not caught**: *modifying* an existing block — a rewritten block keeps its old count and, worse, a
  stale review date. Resetting the date to `null` on modification is therefore a reviewer-diligence
  duty, not something CI can verify.
- **False positive**: moving an untagged (grandfathered) block between files reads as a new untagged
  block in the destination file. Tag it in passing — cheaper than fighting the ratchet.

When you tag previously-untagged blocks, tighten the ratchet with
`node test/JsdocLastReviewed.test.js --update`. Never raise a baseline number to make the check pass —
tag the JSDoc instead.

```typescript
/**
 * Processes user input and validates the data.
 * @param input The user input to process
 * @returns Processed and validated data
 * @lastreviewed null
 */
function processInput(input: string): ProcessedData {
  // implementation
}
```

## Type Maintenance

Whenever making code changes, ensure all TypeScript types are accurate and up to date:

- Update type definitions in `src/types.ts` as needed.
- Ensure function signatures are correct **and not implied**.
- Verify type imports reflect the current codebase.

## Number Formatting

Use underscores for thousands separators in numeric literals (e.g. `1_000`, `10_000_000`).

## Formatting

Prettier governs style (see `.prettierrc`): 120 print width, 2-space tabs, semicolons,
`trailingComma: es5`. Run `npm run format` before committing.

## Branch, Commit, PR, and ClickUp Conventions

Substantive work is tracked by a ClickUp task; feedback-pipeline reports and their tracking tasks live
in the **AI.List** list. The conventions below match this repo's history — follow them so ClickUp's
GitHub integration can auto-link the work.

- **Branches** carry the ClickUp task id with the `CU-` prefix: `CU-<taskid>` for a task-scoped branch,
  or `<type>/<slug>-CU-<taskid>` when a descriptive slug helps (e.g.
  `generic-refactor-and-updates-CU-86bbcwx7p`). The `CU-` spelling is what ClickUp's GitHub
  integration matches — a bare id or another prefix does not auto-link.
- **Commits** use conventional-commit style: `fix(scope):`, `feat:`, `test:`, `refactor:`, `chore:`,
  `docs:`, and `release: vX.Y.Z — summary` for release commits. Reference the ClickUp task in the
  subject or body as `(CU-<taskid>)`. AI-authored commits end with their agent's `Co-Authored-By`
  trailer.
- **PRs** target `master`. CI must pass — type-check, format-check, compile, and the full test suite on
  Node 20 and 22. Expect automated review rounds (e.g. Copilot); address them as follow-up commits on
  the same branch (`fix: address Copilot review on PR #N`). AI-generated PR bodies end with the
  Claude Code attribution line.
- **Feedback-pipeline lifecycle**: when a fix has actually shipped to users, comment on the reporting
  ClickUp task and move it to **"check on 20"** — the bspecs side runs a live verification wave.
  **Never close tasks directly**: a pass is closed by the resolution-note email flow (which also
  notifies reporters); a fail comes back on the "rejected fix" lane with the failing check cited.
- **Shipping chain**: this library reaches users only through its consumers. A core fix is "shipped"
  once a b6p-core release lands **and** a consumer release (b6p-cli, vscode-extension) bundles it —
  not when the PR merges here.
- **Line endings**: repo blobs are LF. On a CRLF checkout (Windows `autocrlf`), a local
  `npm run format-check` false-fails on every file while CI passes — trust CI, or run the check from
  an LF checkout. Do not commit a mass "reformat" for what is actually line-ending noise.

## Overriding Guidelines

In exceptional cases where a guideline is impractical, you may override it — but document the override
with a `//HUMAN-REVIEW-NEEDED` comment explaining the reason and what a human must review.
