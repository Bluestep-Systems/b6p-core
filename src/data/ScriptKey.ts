import { Err } from '../Err';
import { registerSerializable, type SerializableClass } from '../persistence';
import type { JsonValue } from '../types';

const COMPOUND_ID_SEPARATOR = "___";
const SERIALIZABLE_TAG = "ScriptKey";

/**
 * Registry of known script class IDs and their associated metadata.
 * Add new script types here as they become supported.
 */
const SCRIPT_TYPE_REGISTRY = {
  "654015": { type: "formula",  setupPage: "editformuladetails.jsp", mutationName: "updateScriptFormula",     inputType: "UpdateScriptFormulaInput" },
  "530024": { type: "report",   setupPage: "editdetailreport1.jsp",  mutationName: "updateScriptMergeReport", inputType: "UpdateScriptMergeReportInput" },
  "363769": { type: "endpoint", setupPage: "editendpoint.jsp",       mutationName: "updateScriptEndpoint",    inputType: "UpdateScriptEndpointInput" },
} as const;

type ScriptTypeEntry = typeof SCRIPT_TYPE_REGISTRY;
type KnownClassId = keyof ScriptTypeEntry;

/**
 * The known script types, derived from the registry.
 */
export type ScriptType = ScriptTypeEntry[KnownClassId]["type"];

/**
 * Represents a unique script identifier consisting of a classid and seqnum pair.
 *
 * Centralizes parsing, type lookup, and URL construction for script keys.
 * Replaces the previous `{ seqnum: string; classid: string }` plain objects
 * and the `WebDavId` utility class.
 */
export class ScriptKey implements SerializableClass {
  readonly classid: string;
  readonly seqnum: string;

  constructor(classid: string, seqnum: string) {
    if (!classid || !seqnum) {
      throw new Err.ScriptKeyParsingError(`ScriptKey requires non-empty classid and seqnum, got: classid="${classid}", seqnum="${seqnum}"`);
    }
    this.classid = classid;
    this.seqnum = seqnum;
  }

  /**
   * Parse from compound ID format: `"classid___seqnum"`.
   * Replaces the former `WebDavId` class.
   */
  static fromCompoundId(id: string): ScriptKey {
    const match = id.match(/^(\d+)___(\d+)$/);
    if (!match) {
      throw new Err.ScriptKeyParsingError(`Invalid compound ID format. Expected "classid___seqnum", got: ${id}`);
    }
    return new ScriptKey(match[1], match[2]);
  }

  /**
   * Construct from a plain object (e.g. deserialized metadata).
   */
  static from(obj: { classid: string; seqnum: string }): ScriptKey {
    return new ScriptKey(obj.classid, obj.seqnum);
  }

  /**
   * The script type this classid represents, or `undefined` if the classid is not in the registry.
   */
  get scriptType(): ScriptType | undefined {
    return this.registryEntry?.type;
  }

  /**
   * The JSP setup page for this script type, or `undefined` if not in the registry.
   */
  get setupPage(): string | undefined {
    return this.registryEntry?.setupPage;
  }

  /**
   * The GraphQL mutation name for updating this script type (e.g. "updateScriptFormula").
   */
  get mutationName(): string | undefined {
    return this.registryEntry?.mutationName;
  }

  /**
   * The GraphQL input type name for updating this script type (e.g. "UpdateScriptFormulaInput").
   */
  get inputType(): string | undefined {
    return this.registryEntry?.inputType;
  }

  /**
   * Build the full setup URL for this script, given a server origin.
   * @throws if this classid has no known setup page.
   */
  buildSetupUrl(origin: string | URL): string {
    const page = this.setupPage;
    if (!page) {
      throw new Error(`No setup page known for classid: ${this.classid}`);
    }
    return `${origin}shared/admin/applications/relate/${page}?_event=edit&_id=${this.toCompoundId()}`;
  }

  /**
   * Serialize to compound ID format: `"classid___seqnum"`.
   */
  toCompoundId(): string {
    return `${this.classid}${COMPOUND_ID_SEPARATOR}${this.seqnum}`;
  }

  /**
   * Serialize to a plain object suitable for JSON storage.
   * Includes the `__storable` tag for automatic hydration by the persistence layer.
   */
  toJSON(): { __serializable: string; classid: string; seqnum: string;[key: string]: JsonValue; } {
    return { __serializable: SERIALIZABLE_TAG, classid: this.classid, seqnum: this.seqnum };
  }

  private get registryEntry(): ScriptTypeEntry[KnownClassId] | undefined {
    if (this.classid in SCRIPT_TYPE_REGISTRY) {
      return SCRIPT_TYPE_REGISTRY[this.classid as KnownClassId];
    }
    return undefined;
  }
}

registerSerializable(SERIALIZABLE_TAG, (data) => new ScriptKey(data.classid as string, data.seqnum as string));
