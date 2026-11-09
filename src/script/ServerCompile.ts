import { Http } from "../constants";
import { MimeTypes } from "../constants/MimeTypes";
import { Err } from "../Err";
import type { ScriptRoot } from "./ScriptRoot";

/**
 * The statuses the platform's `compileDraft` reports for a script (`extensions.bluestepCompile[0].status`).
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
 * A status the platform reported. `UNKNOWN` is the fallback for a status this version of core does
 * not know (a newer server); the raw text is in {@link DraftCompileOutcome.rawStatus}.
 * @lastreviewed null
 */
export type DraftCompileStatus = (typeof KNOWN_DRAFT_COMPILE_STATUSES)[number] | "UNKNOWN";

/**
 * Why the platform refused a publish (`extensions.reason` of a `PUBLISH_REFUSED` error).
 * @lastreviewed null
 */
export const KNOWN_PUBLISH_REFUSAL_REASONS = [
  "GATE_TRIPPED",
  "EMIT_WITHHELD",
  "ENTRYPOINT_MISSING",
  "OUTPUT_SHADOWS",
  "COMPILER_UNAVAILABLE",
  "BUSY",
  "INPUT_INCOMPLETE",
  "WRITE_FAILED",
  "NOT_PERMITTED",
] as const;

/**
 * A refusal reason. `UNKNOWN` is the fallback for a reason this version of core does not know; the
 * raw text is in {@link PublishRefusedError.rawReason}.
 * @lastreviewed null
 */
export type PublishRefusalReason = (typeof KNOWN_PUBLISH_REFUSAL_REASONS)[number] | "UNKNOWN";

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
   * What kind of problem, e.g. `CONFIG_UNSUPPORTED_OPTION`, `CONFIG_BROKEN`, `OUTPUT_DIFFERS`,
   * `OUTPUT_UNVERIFIABLE` or `OUTPUT_SHADOWS`. Kept as the platform's text so a newer kind passes through.
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
 * What the platform's `compileDraft` came to for the script.
 * @lastreviewed null
 */
export interface DraftCompileOutcome {
  /** The status, or `UNKNOWN` for one core does not know. @lastreviewed null */
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
 * What a `takeSnapshot` came to (`extensions.bluestepPublish[0]`, or the detail of a refusal).
 * @lastreviewed null
 */
export interface PublishOutcome {
  /** Whether the snapshot was published. @lastreviewed null */
  published: boolean;
  /** Files of `snapshot/` created or changed. @lastreviewed null */
  written: number;
  /** Files of `snapshot/` removed. @lastreviewed null */
  deleted: number;
  /** Number of error diagnostics. @lastreviewed null */
  errors: number;
  /** Number of warning diagnostics. @lastreviewed null */
  warnings: number;
  /** The first diagnostics, errors first. @lastreviewed null */
  diagnostics: CompileDiagnostic[];
  /** How many diagnostics the platform left out of `diagnostics`. @lastreviewed null */
  diagnosticsOmitted: number;
  /** The tsconfigs whose output the compiler or the gate withheld. @lastreviewed null */
  withheld: string[];
  /** The main entrypoint the published tree has no compiled output for, when that is the refusal. @lastreviewed null */
  entrypoint?: string;
  /** The save gate's findings, when the compile got as far as it. @lastreviewed null */
  gate?: GateReport;
}

/**
 * The compile statuses after which a snapshot push goes on to publish: there is either compiled
 * output or nothing for the platform to build.
 * @lastreviewed null
 */
export const PUBLISHABLE_COMPILE_STATUSES: readonly DraftCompileStatus[] = [
  "COMPILED",
  "NOTHING_TO_COMPILE",
  "SKIPPED_EXTERNALLY_BUILT",
];

/**
 * Whether a compile status lets a snapshot push go on to publish.
 * @lastreviewed null
 */
export function compileAllowsPublish(status: DraftCompileStatus): boolean {
  return PUBLISHABLE_COMPILE_STATUSES.includes(status);
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
 * The retry policy of the platform contract: `BUSY` 3 times 5 s apart, `INPUT_INCOMPLETE` 3 times
 * 2 s apart, `COMPILER_UNAVAILABLE` once, and a network failure once. Each kind has its own budget.
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
 * What the server-compile calls need of a script: the platform context's session and logger, its
 * key and its origin. A {@link ScriptRoot} satisfies it.
 * @lastreviewed null
 */
export type ServerCompileTarget = Pick<ScriptRoot, "getScriptKey" | "anyOrigin"> & {
  readonly ctx: Pick<ScriptRoot["ctx"], "sessionManager" | "logger">;
};

/**
 * Options shared by {@link compileDraft} and {@link takeSnapshot}.
 * @lastreviewed null
 */
export interface ServerCompileOptions {
  /**
   * Waits between retries. Defaults to a real timer; tests inject a recorder.
   * @lastreviewed null
   */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
 * Reads one element of `extensions.bluestepCompile`. A status core does not know becomes `UNKNOWN`
 * with the raw text kept; a missing outcome (`undefined`) is `UNKNOWN` with empty raw text.
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

/**
 * Reads a publish outcome: an element of `extensions.bluestepPublish`, or the `extensions.publish`
 * detail of a refusal. `published` is read from the data; a refusal's detail has it false.
 * @param raw The value as parsed JSON
 * @param fallbackPublished What `published` is when the data does not say
 * @lastreviewed null
 */
export function parsePublishOutcome(raw: unknown, fallbackPublished: boolean): PublishOutcome {
  const item = isRecord(raw) ? raw : {};
  const outcome: PublishOutcome = {
    published: typeof item.published === "boolean" ? item.published : fallbackPublished,
    written: num(item.written),
    deleted: num(item.deleted),
    errors: num(item.errors),
    warnings: num(item.warnings),
    diagnostics: parseDiagnostics(item.diagnostics),
    diagnosticsOmitted: num(item.diagnosticsOmitted),
    withheld: strings(item.withheld),
  };
  if (typeof item.entrypoint === "string") {
    outcome.entrypoint = item.entrypoint;
  }
  const gate = parseGate(item.gate);
  if (gate) {
    outcome.gate = gate;
  }
  return outcome;
}

/** The pieces of one GraphQL response this module reads. @lastreviewed null */
interface MutationResponse {
  /** Parsed `extensions` of the response body. @lastreviewed null */
  extensions: Json;
  /** The response's `errors`, each with its message and error-level `extensions`. @lastreviewed null */
  errors: { message: string; extensions: Json }[];
}

function isGatewayStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

/**
 * Sends the script type's GraphQL update mutation with one action input and returns the parts of
 * the response this module reads. A thrown request, or a 502/503/504, is a network failure and is
 * retried once; any other non-2xx is thrown at once.
 * @lastreviewed null
 */
async function sendScriptMutation(
  target: ServerCompileTarget,
  action: "compileDraft" | "takeSnapshot",
  phase: "compile" | "publish",
  sleep: (ms: number) => Promise<void>
): Promise<MutationResponse> {
  const scriptKey = await target.getScriptKey();
  const mutationName = scriptKey.mutationName;
  const inputType = scriptKey.inputType;
  if (!mutationName || !inputType) {
    throw new Err.ServerCompileRequestError(
      `No GraphQL mutation is known for script class ${scriptKey.classid}, so its draft cannot be ${
        phase === "compile" ? "compiled" : "published"
      } on the platform.`,
      { phase, messages: [], networkFailure: false }
    );
  }
  const gqlUrl = new URL("gql", await target.anyOrigin());
  const query = `mutation Script($inputs: [${inputType}!]!) { ${mutationName}(inputs: $inputs) { id } }`;
  const body = JSON.stringify({ query, variables: { inputs: [{ topId: scriptKey.toCompoundId(), [action]: true }] } });

  const { times, delayMs } = COMPILE_RETRY.NETWORK;
  let lastFailure = "";
  for (let attempt = 0; attempt <= times; attempt++) {
    if (attempt > 0) {
      target.ctx.logger.info(`${action} request failed (${lastFailure}); retrying in ${delayMs}ms...`);
      await sleep(delayMs);
    }
    let response: Response;
    try {
      // The init OBJECT is per-attempt: csrfFetch mutates `headers` in place.
      response = await target.ctx.sessionManager.csrfFetch(gqlUrl, {
        method: Http.Methods.POST,
        headers: { [Http.Headers.CONTENT_TYPE]: MimeTypes.APPLICATION_JSON },
        body,
      });
    } catch (e) {
      lastFailure = e instanceof Error ? e.message : String(e);
      continue;
    }
    if (isGatewayStatus(response.status)) {
      lastFailure = `HTTP ${response.status}`;
      continue;
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Err.ServerCompileRequestError(`The platform answered ${action} with ${response.status} ${text}`, {
        phase,
        messages: [text],
        networkFailure: false,
      });
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch (e) {
      throw new Err.ServerCompileRequestError(
        `The platform's answer to ${action} was not readable JSON: ${e instanceof Error ? e.message : e}`,
        { phase, messages: [], networkFailure: false }
      );
    }
    const root = isRecord(json) ? json : {};
    const errors = Array.isArray(root.errors)
      ? root.errors.filter(isRecord).map((e) => ({
          message: str(e.message) ?? "",
          extensions: isRecord(e.extensions) ? e.extensions : {},
        }))
      : [];
    return { extensions: isRecord(root.extensions) ? root.extensions : {}, errors };
  }
  throw new Err.ServerCompileRequestError(
    `The ${action} request to the platform failed twice (${lastFailure}). It may or may not have run.`,
    { phase, messages: [lastFailure], networkFailure: true }
  );
}

/**
 * Asks the platform to compile the script's whole draft (the GraphQL `compileDraft` input) and
 * reports what it came to. The platform never compiles on a WebDAV write, so a push ends with this.
 *
 * Retries by {@link COMPILE_RETRY}: `BUSY`, `INPUT_INCOMPLETE` and `COMPILER_UNAVAILABLE` outcomes
 * and network failures. When the retries run out, the last outcome is returned. A trip, a withheld
 * emit, a failed write and the rest are results, not errors: the sources are saved either way.
 * @param target The script (a `ScriptRoot`)
 * @param opts.sleep Waits between retries
 * @returns The compile outcome
 * @throws an {@link Err.ServerCompileRequestError} when the platform answers with a GraphQL error
 *   (e.g. the caller may not edit the script), or the request failed twice
 * @lastreviewed null
 */
export async function compileDraft(
  target: ServerCompileTarget,
  opts?: ServerCompileOptions
): Promise<DraftCompileOutcome> {
  const sleep = opts?.sleep ?? realSleep;
  const used = { BUSY: 0, INPUT_INCOMPLETE: 0, COMPILER_UNAVAILABLE: 0 };
  for (;;) {
    const response = await sendScriptMutation(target, "compileDraft", "compile", sleep);
    if (response.errors.length > 0) {
      const messages = response.errors.map((e) => e.message);
      throw new Err.ServerCompileRequestError(`The platform refused to compile the draft: ${messages.join("; ")}`, {
        phase: "compile",
        messages,
        networkFailure: false,
      });
    }
    const list = response.extensions.bluestepCompile;
    const outcome = parseDraftCompileOutcome(Array.isArray(list) ? list[0] : undefined);
    if (
      outcome.status === "BUSY" ||
      outcome.status === "INPUT_INCOMPLETE" ||
      outcome.status === "COMPILER_UNAVAILABLE"
    ) {
      const policy = COMPILE_RETRY[outcome.status];
      if (used[outcome.status] < policy.times) {
        used[outcome.status]++;
        target.ctx.logger.info(
          `Draft compile reported ${outcome.status}; retrying in ${policy.delayMs}ms ` +
            `(${used[outcome.status]} of ${policy.times})...`
        );
        await sleep(policy.delayMs);
        continue;
      }
    }
    return outcome;
  }
}

/**
 * Asks the platform to publish the script's draft as a snapshot (the GraphQL `takeSnapshot` input).
 * The platform recompiles against sibling snapshots and writes `snapshot/` itself, so core never
 * writes there. Call this after {@link compileDraft} answered with a status
 * {@link compileAllowsPublish} accepts.
 *
 * A `PUBLISH_REFUSED` error of reason `BUSY` or `INPUT_INCOMPLETE` is retried by
 * {@link COMPILE_RETRY}; any other refusal is thrown. The refusal is read from the error's
 * `extensions.reason` and `extensions.publish`, never from its message.
 * @param target The script (a `ScriptRoot`)
 * @param opts.sleep Waits between retries
 * @returns The publish outcome (`published: true`)
 * @throws an {@link Err.PublishRefusedError} when the platform refuses the publish
 * @throws an {@link Err.ServerCompileRequestError} on any other GraphQL error, or when the request
 *   failed twice
 * @lastreviewed null
 */
export async function takeSnapshot(target: ServerCompileTarget, opts?: ServerCompileOptions): Promise<PublishOutcome> {
  const sleep = opts?.sleep ?? realSleep;
  const used = { BUSY: 0, INPUT_INCOMPLETE: 0 };
  for (;;) {
    const response = await sendScriptMutation(target, "takeSnapshot", "publish", sleep);
    if (response.errors.length === 0) {
      const list = response.extensions.bluestepPublish;
      return parsePublishOutcome(Array.isArray(list) ? list[0] : undefined, true);
    }
    const refused = response.errors.find((e) => e.extensions.code === "PUBLISH_REFUSED");
    if (!refused) {
      const messages = response.errors.map((e) => e.message);
      throw new Err.ServerCompileRequestError(`The platform refused to publish the snapshot: ${messages.join("; ")}`, {
        phase: "publish",
        messages,
        networkFailure: false,
      });
    }
    const rawReason = str(refused.extensions.reason) ?? "";
    const reason: PublishRefusalReason = (KNOWN_PUBLISH_REFUSAL_REASONS as readonly string[]).includes(rawReason)
      ? (rawReason as PublishRefusalReason)
      : "UNKNOWN";
    if (reason === "BUSY" || reason === "INPUT_INCOMPLETE") {
      const policy = COMPILE_RETRY[reason];
      if (used[reason] < policy.times) {
        used[reason]++;
        target.ctx.logger.info(
          `Snapshot publish refused as ${reason}; retrying in ${policy.delayMs}ms (${used[reason]} of ${policy.times})...`
        );
        await sleep(policy.delayMs);
        continue;
      }
    }
    throw new Err.PublishRefusedError(
      `The platform refused to publish the snapshot (${rawReason || "no reason given"}); the published script is unchanged.`,
      { reason, rawReason, publish: parsePublishOutcome(refused.extensions.publish, false) }
    );
  }
}
