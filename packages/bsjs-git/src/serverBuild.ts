/**
 * The platform's build of a git-managed draft (GraphQL `compileDraft` with `expectedDraftSha`): what it answers and how
 * to read it. The platform compiles the draft branch at the pushed commit and commits the output, and the build
 * manifest when it vouches for the build, as one build commit on the draft branch. No client compiles.
 *
 * Everything here is pure (no file system, no Node built-ins).
 * @lastreviewed null
 */

/**
 * The subject of the platform's build commit (web `UserCodeScriptHelper.BUILD_MESSAGE`). Informational only: what
 * makes a commit a build is its {@link BUILD_OF_TRAILER} trailer, never its subject.
 * @lastreviewed null
 */
export const BUILD_COMMIT_SUBJECT = "Build draft";

/**
 * The trailer the platform puts on every build commit: `Bluestep-Build-Of: <source sha>`, the source being the nearest
 * ancestor that is not a build (the commit that was pushed), the same across a chain of rebuilds.
 * @lastreviewed null
 */
export const BUILD_OF_TRAILER = "Bluestep-Build-Of";

/**
 * The source sha a commit message's {@link BUILD_OF_TRAILER} trailer names, or `null` when it has none (or more than
 * one, or one that is not a full lowercase sha). Only the last paragraph of the message is read, as git reads trailers.
 * @param message A commit's full message
 * @lastreviewed null
 */
export function buildSourceOf(message: string): string | null {
  const paragraphs = message.replace(/\s+$/, "").split(/\n[ \t]*\n/);
  if (paragraphs.length < 2) {
    return null;
  }
  const found: string[] = [];
  for (const line of paragraphs[paragraphs.length - 1].split("\n")) {
    const match = /^([A-Za-z0-9-]+)[ \t]*:[ \t]*(.*?)[ \t]*$/.exec(line);
    if (match && match[1].toLowerCase() === BUILD_OF_TRAILER.toLowerCase()) {
      found.push(match[2]);
    }
  }
  return found.length === 1 && SHA.test(found[0]) ? found[0] : null;
}

/**
 * The statuses the platform reports for a compile (`extensions.bluestepCompile[0].status`).
 * @lastreviewed null
 */
export const KNOWN_DRAFT_COMPILE_STATUSES = [
  "COMPILED",
  "GATE_TRIPPED",
  "EMIT_WITHHELD",
  "NOTHING_TO_COMPILE",
  "SKIPPED_GIT_MANAGED",
  "SKIPPED_EXTERNALLY_BUILT",
  "OUTPUT_UPLOAD",
  "NOT_PERMITTED",
  "COMPILER_UNAVAILABLE",
  "WRITE_FAILED",
  "INPUT_INCOMPLETE",
  "BUSY",
] as const;

/**
 * A status the platform reported. `UNKNOWN` is the fallback for a status this version does not know (a newer server);
 * the raw text is in {@link DraftCompileOutcome.rawStatus}.
 * @lastreviewed null
 */
export type DraftCompileStatus = (typeof KNOWN_DRAFT_COMPILE_STATUSES)[number] | "UNKNOWN";

/**
 * One compiler or compile-engine message from the platform.
 * @lastreviewed null
 */
export interface CompileDiagnostic {
  /** Who produced it: `TYPESCRIPT` (the compiler) or `ENGINE` (the platform's compile step). @lastreviewed null */
  origin: string;
  /** `ERROR`, `WARNING` or `INFO`. @lastreviewed null */
  severity: string;
  /** The compiler's diagnostic code, when it has one. @lastreviewed null */
  code?: number;
  /** The file the message is about, relative to the script, when it names one. @lastreviewed null */
  file?: string;
  /** 1-based line, when known. @lastreviewed null */
  line?: number;
  /** 1-based column, when known. @lastreviewed null */
  column?: number;
  /** The message text. @lastreviewed null */
  message: string;
}

/**
 * One thing the platform's save gate found.
 * @lastreviewed null
 */
export interface GateProblem {
  /**
   * What kind of problem, e.g. `CONFIG_UNSUPPORTED_OPTION`, `CONFIG_BROKEN`, `OUTPUT_DIFFERS`, `OUTPUT_UNVERIFIABLE` or
   * `OUTPUT_SHADOWS`. Kept as the platform's text so a newer kind passes through.
   * @lastreviewed null
   */
  kind: string;
  /** The tsconfig the problem belongs to, relative to the script. @lastreviewed null */
  tsconfig: string;
  /** The file it is about, when it names one. @lastreviewed null */
  file?: string;
  /** What is wrong. @lastreviewed null */
  message: string;
  /** What differs, when the platform shows it. @lastreviewed null */
  diff?: string;
  /** Whether the author accepted it already, so it no longer holds anything back. @lastreviewed null */
  accepted: boolean;
}

/**
 * What the platform's save gate found on a compile.
 * @lastreviewed null
 */
export interface GateReport {
  /** True when the gate holds back the output of at least one project. @lastreviewed null */
  tripped: boolean;
  /** The tsconfigs whose output was held back. @lastreviewed null */
  withheld: string[];
  /** How many output files were compared with the script's existing output. @lastreviewed null */
  checked: number;
  /** The problems, capped by the platform. @lastreviewed null */
  problems: GateProblem[];
  /** How many problems the platform left out of `problems`. @lastreviewed null */
  problemsOmitted: number;
}

/**
 * What the platform's compile of the draft came to.
 * @lastreviewed null
 */
export interface DraftCompileOutcome {
  /** The status, or `UNKNOWN` for one this version does not know. @lastreviewed null */
  status: DraftCompileStatus;
  /** The status text exactly as the platform sent it. @lastreviewed null */
  rawStatus: string;
  /** Number of error diagnostics. @lastreviewed null */
  errors: number;
  /** Number of warning diagnostics. @lastreviewed null */
  warnings: number;
  /** Output files created or changed. @lastreviewed null */
  written: number;
  /** Output files removed. @lastreviewed null */
  deleted: number;
  /** The first diagnostics, errors first (the platform lists at most 20). @lastreviewed null */
  diagnostics: CompileDiagnostic[];
  /** How many diagnostics the platform left out of `diagnostics`. @lastreviewed null */
  diagnosticsOmitted: number;
  /** The save gate's findings, when it ran. @lastreviewed null */
  gate?: GateReport;
}

/**
 * The build commit the platform made (`extensions.bluestepBuild[0]`).
 * @lastreviewed null
 */
export interface DraftBuildCommit {
  /**
   * The draft branch's head after the build: the build commit, or the pushed commit itself when the build changed
   * nothing (already built, or nothing to build). `null` when the platform gave none.
   * @lastreviewed null
   */
  commit: string | null;
  /**
   * Whether a publish's build check passes at `commit`: the platform vouched for the build (every project's output
   * written, no blocking error, so the manifest is in the commit), or the draft needs none (externally built, nothing
   * to build).
   * @lastreviewed null
   */
  vouched: boolean;
}

/**
 * How a retryable outcome is retried: how many extra attempts, and the wait before each.
 * @lastreviewed null
 */
export interface RetryPolicy {
  /** Extra attempts after the first. @lastreviewed null */
  times: number;
  /** Milliseconds to wait before each extra attempt. @lastreviewed null */
  delayMs: number;
}

/**
 * The retry policy of the platform contract: `BUSY` 3 times 5 s apart, `INPUT_INCOMPLETE` 3 times 2 s apart,
 * `COMPILER_UNAVAILABLE` once, and a failed request once. Each kind has its own budget.
 * @lastreviewed null
 */
export const COMPILE_RETRY: {
  readonly BUSY: RetryPolicy;
  readonly INPUT_INCOMPLETE: RetryPolicy;
  readonly COMPILER_UNAVAILABLE: RetryPolicy;
  readonly NETWORK: RetryPolicy;
} = {
  BUSY: { times: 3, delayMs: 5_000 },
  INPUT_INCOMPLETE: { times: 3, delayMs: 2_000 },
  COMPILER_UNAVAILABLE: { times: 1, delayMs: 2_000 },
  NETWORK: { times: 1, delayMs: 2_000 },
};

/**
 * The compile statuses after which a draft can go on to publish: there is compiled output, or nothing for the platform
 * to build.
 * @lastreviewed null
 */
export const PUBLISHABLE_COMPILE_STATUSES: readonly DraftCompileStatus[] = [
  "COMPILED",
  "NOTHING_TO_COMPILE",
  "SKIPPED_EXTERNALLY_BUILT",
];

/**
 * Whether a compile status lets a draft go on to publish.
 * @lastreviewed null
 */
export function compileAllowsPublish(status: DraftCompileStatus): boolean {
  return PUBLISHABLE_COMPILE_STATUSES.includes(status);
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function parseDiagnostics(value: unknown): CompileDiagnostic[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: CompileDiagnostic[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const d: CompileDiagnostic = {
      origin: str(item.origin) ?? "",
      severity: str(item.severity) ?? "",
      message: str(item.message) ?? "",
    };
    if (typeof item.code === "number") {
      d.code = item.code;
    }
    if (typeof item.file === "string") {
      d.file = item.file;
    }
    if (typeof item.line === "number") {
      d.line = item.line;
    }
    if (typeof item.column === "number") {
      d.column = item.column;
    }
    out.push(d);
  }
  return out;
}

function parseGate(value: unknown): GateReport | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const problems: GateProblem[] = [];
  if (Array.isArray(value.problems)) {
    for (const p of value.problems) {
      if (!isRecord(p)) {
        continue;
      }
      const problem: GateProblem = {
        kind: str(p.kind) ?? "",
        tsconfig: str(p.tsconfig) ?? "",
        message: str(p.message) ?? "",
        accepted: p.accepted === true,
      };
      if (typeof p.file === "string") {
        problem.file = p.file;
      }
      if (typeof p.diff === "string") {
        problem.diff = p.diff;
      }
      problems.push(problem);
    }
  }
  return {
    tripped: value.tripped === true,
    withheld: strings(value.withheld),
    checked: num(value.checked),
    problems,
    problemsOmitted: num(value.problemsOmitted),
  };
}

/**
 * Reads one element of `extensions.bluestepCompile`. A status this version does not know becomes `UNKNOWN` with the raw
 * text kept; a missing outcome (`undefined`) is `UNKNOWN` with empty raw text.
 * @param raw The element as parsed JSON
 * @lastreviewed null
 */
export function parseDraftCompileOutcome(raw: unknown): DraftCompileOutcome {
  const item = isRecord(raw) ? raw : {};
  const rawStatus = str(item.status) ?? "";
  const known = (KNOWN_DRAFT_COMPILE_STATUSES as readonly string[]).includes(rawStatus);
  const outcome: DraftCompileOutcome = {
    status: known ? (rawStatus as DraftCompileStatus) : "UNKNOWN",
    rawStatus,
    errors: num(item.errors),
    warnings: num(item.warnings),
    written: num(item.written),
    deleted: num(item.deleted),
    diagnostics: parseDiagnostics(item.diagnostics),
    diagnosticsOmitted: num(item.diagnosticsOmitted),
  };
  const gate = parseGate(item.gate);
  if (gate) {
    outcome.gate = gate;
  }
  return outcome;
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Reads one element of `extensions.bluestepBuild` (`{ script, draftSha, commit, built, vouched, status }`; only
 * `commit` and `vouched` are read: a build commit was made exactly when `commit` differs from the pushed sha). A commit
 * that is not a full sha (40 or 64 lowercase hex) reads as `null`; `vouched` is true only when the platform says so.
 * @param raw The element as parsed JSON
 * @lastreviewed null
 */
export function parseDraftBuildCommit(raw: unknown): DraftBuildCommit {
  const item = isRecord(raw) ? raw : {};
  const commit = str(item.commit);
  return { commit: commit && SHA.test(commit) ? commit : null, vouched: item.vouched === true };
}
