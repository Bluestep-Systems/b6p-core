import { mutatePublic } from "../persistence/lockedMutation";
import { PublicKeys } from "../persistence/PersistenceKeys";
import type { Persistence } from "../providers";

/**
 * A config change to one key's resets that was started and may not have finished: `emptiesBefore`
 * is how many empty values the key had in the file just before it, so the next run can tell from
 * the file whether it happened.
 * @lastreviewed null
 */
export interface GitCredentialResetChange {
  readonly op: "add" | "remove";
  readonly emptiesBefore: number;
}

/**
 * The resets b6p installed under one exact key in one file.
 * @lastreviewed null
 */
export interface GitCredentialResetRecord {
  /**
   * How many of the key's empty `helper =` values in the file are b6p's.
   * @lastreviewed null
   */
  readonly installed: number;
  readonly pending?: GitCredentialResetChange;
}

/**
 * Every recorded reset: file path → exact config key (as written, case kept) → record.
 * @lastreviewed null
 */
export type GitCredentialResetsByFile = Record<string, Record<string, GitCredentialResetRecord>>;

function isRecord(value: unknown): value is GitCredentialResetRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const r = value as GitCredentialResetRecord;
  if (!Number.isInteger(r.installed) || r.installed < 0) {
    return false;
  }
  return (
    r.pending === undefined ||
    ((r.pending.op === "add" || r.pending.op === "remove") && Number.isInteger(r.pending.emptiesBefore))
  );
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
 * Which `helper =` resets in the user's git config b6p wrote, so removal takes out only those and
 * never one the user wrote, whatever sits next to it. Public state `b6p:git_credential_resets`:
 * `{ "<file>": { "<exact key>": { installed, pending? } } }`.
 *
 * A config change is written here before it is made (`pending`, with the count of empty values
 * the key had) and again after it (`installed`), so a run that stopped between the two is settled
 * by the next one from the file. Every change is a locked read-modify-write ({@link mutatePublic}).
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
   * Replace the record for `key` in `file`; `undefined` (or nothing installed and nothing pending)
   * removes it.
   * @lastreviewed null
   */
  async put(file: string, key: string, record: GitCredentialResetRecord | undefined): Promise<void> {
    await mutatePublic(this.persistence, PublicKeys.GIT_CREDENTIAL_RESETS, (current) => {
      const all = clean(current);
      const keys = { ...(all[file] ?? {}) };
      if (record === undefined || (record.installed === 0 && record.pending === undefined)) {
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
}
