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
replaces `null` with the review date after verifying accuracy.

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

## Overriding Guidelines

In exceptional cases where a guideline is impractical, you may override it — but document the override
with a `//HUMAN-REVIEW-NEEDED` comment explaining the reason and what a human must review.
