import { UnknownScriptTypeError } from "./errors";

const COMPOUND_ID = /^(\d+)___(\d+)$/;

/**
 * A script's identity: the class id and seqnum pair. Structurally satisfied by `b6p-core`'s `ScriptKey`, so a
 * caller holding one passes it straight in.
 * @lastreviewed null
 */
export interface ScriptRef {
  readonly classid: string;
  readonly seqnum: string;
}

/**
 * The script types a publish is known for, by class id: the GraphQL mutation and input type that carry
 * `takeSnapshot`.
 * @lastreviewed null
 */
export const SCRIPT_PUBLISH_TYPES = {
  "654015": { type: "formula", mutationName: "updateScriptFormula", inputType: "UpdateScriptFormulaInput" },
  "530024": { type: "report", mutationName: "updateScriptMergeReport", inputType: "UpdateScriptMergeReportInput" },
  "363769": { type: "endpoint", mutationName: "updateScriptEndpoint", inputType: "UpdateScriptEndpointInput" },
} as const;

/**
 * The mutation and input type names that publish the script's type.
 * @lastreviewed null
 */
export interface PublishMutation {
  readonly mutationName: string;
  readonly inputType: string;
}

/**
 * Parses `"classid___seqnum"`.
 * @throws if the text is not a compound script id.
 * @lastreviewed null
 */
export function parseCompoundId(id: string): ScriptRef {
  const match = COMPOUND_ID.exec(id);
  if (!match) {
    throw new Error(`Invalid compound script id. Expected "classid___seqnum", got: ${id}`);
  }
  return { classid: match[1], seqnum: match[2] };
}

/**
 * `"classid___seqnum"`: the script's repo name on the proxy, and its id in the GraphQL API.
 * @lastreviewed null
 */
export function compoundId(key: ScriptRef): string {
  return `${key.classid}___${key.seqnum}`;
}

/**
 * The publish mutation for the script's type.
 * @throws {UnknownScriptTypeError} for a class id with no known publish mutation.
 * @lastreviewed null
 */
export function publishMutationFor(key: ScriptRef): PublishMutation {
  const entry = (SCRIPT_PUBLISH_TYPES as Record<string, PublishMutation | undefined>)[key.classid];
  if (!entry) {
    throw new UnknownScriptTypeError(key.classid);
  }
  return entry;
}
