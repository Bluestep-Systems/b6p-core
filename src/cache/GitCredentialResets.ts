import { exclusive, mutatePublic } from "../persistence/lockedMutation";
import { PublicKeys } from "../persistence/PersistenceKeys";
import type { Persistence } from "../providers";

/**
 * Where b6p's reset under one key in one file stands.
 *
 * - `installed`: b6p wrote the reset and `helper` straight after it. It stays b6p's only while
 *   `helper` directly follows an empty value among that key's values in that file; once it does
 *   not (the user took b6p's helper out, say), b6p drops the record and claims nothing.
 * - `adding`: b6p is about to add the reset, then `helper`; the key had `emptiesBefore` empty
 *   values. Settled as not done when it still has that many, as `installed` when it has one more
 *   and the pair is there, and as `unconfirmed` otherwise.
 * - `removing`: b6p is about to remove its reset, the key's only empty value (`emptiesBefore` is
 *   1), and then `helper`. Settled as done when the key has no empty value left, as `installed`
 *   when it still has that one and the pair is there, and as `unconfirmed` otherwise.
 * - `unconfirmed`: a change was interrupted and the file does not show which empty value is b6p's.
 *   Nothing is removed; the next setup or removal that covers the key reports it and forgets it.
 * @lastreviewed null
 */
export type GitCredentialResetState = "installed" | "adding" | "removing" | "unconfirmed";

/**
 * b6p's reset under one exact key in one file.
 * @lastreviewed null
 */
export interface GitCredentialResetRecord {
  readonly state: GitCredentialResetState;
  /**
   * The helper command written straight after the reset.
   * @lastreviewed null
   */
  readonly helper: string;
  /**
   * For `adding` and `removing`: how many empty values the key had in the file just before.
   * @lastreviewed null
   */
  readonly emptiesBefore?: number;
}

/**
 * Every record: file path (as b6p wrote to it or git reported it) → exact config key (as written,
 * case kept) → record.
 * @lastreviewed null
 */
export type GitCredentialResetsByFile = Record<string, Record<string, GitCredentialResetRecord>>;

const STATES: ReadonlySet<string> = new Set(["installed", "adding", "removing", "unconfirmed"]);

function isRecord(value: unknown): value is GitCredentialResetRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const r = value as GitCredentialResetRecord;
  if (!STATES.has(r.state) || typeof r.helper !== "string") {
    return false;
  }
  const counted = r.state === "adding" || r.state === "removing";
  return counted ? Number.isInteger(r.emptiesBefore) && (r.emptiesBefore ?? -1) >= 0 : r.emptiesBefore === undefined;
}

function clean(stored: unknown): GitCredentialResetsByFile {
  const out: GitCredentialResetsByFile = {};
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
    return out;
  }
  for (const [file, keys] of Object.entries(stored)) {
    if (typeof keys !== "object" || keys === null) {
      continue;
    }
    for (const [key, record] of Object.entries(keys)) {
      if (isRecord(record)) {
        (out[file] ??= {})[key] = record;
      }
    }
  }
  return out;
}

/**
 * The name of the lock every setup and removal of b6p's git config entries holds from start to
 * end ({@link GitCredentialResets.exclusive}).
 * @lastreviewed null
 */
export const GIT_CONFIG_LOCK = "b6p:git_credential_config";

/**
 * Which `helper =` resets in the user's git config b6p wrote, so removal takes out only those and
 * never one the user wrote, whatever sits next to it. Public state `b6p:git_credential_resets`:
 * `{ "<file>": { "<exact key>": { state, helper, emptiesBefore? } } }`.
 *
 * A config change is written here before it is made (`adding`, `removing`) and again after it, so
 * a run that stopped between the two is settled by the next one from the file
 * ({@link GitCredentialResetState}). Each write is a locked read-modify-write
 * ({@link mutatePublic}), and the whole of a setup or removal runs inside {@link exclusive}.
 *
 * The record outlives `clearSettings()` and `clearAll()` (see `B6PCore`), because the entries it
 * describes stay in the user's git config until a removal takes them out.
 * @lastreviewed null
 */
export class GitCredentialResets {
  constructor(private readonly persistence: Persistence) {}

  /**
   * Every record.
   * @lastreviewed null
   */
  async all(): Promise<GitCredentialResetsByFile> {
    return clean(await this.persistence.get<unknown>(PublicKeys.GIT_CREDENTIAL_RESETS));
  }

  /**
   * Replace the record for `key` in `file`; `undefined` removes it.
   * @lastreviewed null
   */
  async put(file: string, key: string, record: GitCredentialResetRecord | undefined): Promise<void> {
    await mutatePublic(this.persistence, PublicKeys.GIT_CREDENTIAL_RESETS, (current) => {
      const all = clean(current);
      const keys = { ...(all[file] ?? {}) };
      if (record === undefined) {
        delete keys[key];
      } else {
        keys[key] = record;
      }
      if (Object.keys(keys).length === 0) {
        delete all[file];
      } else {
        all[file] = keys;
      }
      return { changed: true, next: all, result: undefined };
    });
  }

  /**
   * Run `work` holding the git config lock ({@link GIT_CONFIG_LOCK}): in this process after every
   * earlier holder on the same persistence object, and across processes under
   * `Persistence.withLock` when the persistence has it. One setup or removal holds it from reading
   * the config to settling the last record, so two never interleave.
   * @lastreviewed null
   */
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    return exclusive(this.persistence, GIT_CONFIG_LOCK, work);
  }
}
